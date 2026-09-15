import type { Edge, Node } from '@xyflow/react';
import { Check, Copy, GitCompare, Github, History, Package, Search, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ComparisonInput, type ComparisonSpec } from './components/ComparisonInput';
import { ComparisonView, type ComparisonSide } from './components/ComparisonView';
import { GraphView } from './components/GraphView';
import { Legend } from './components/Legend';
import { LoadingOverlay } from './components/LoadingOverlay';
import { SidebarInfo } from './components/SidebarInfo';
import { TimelineView } from './components/TimelineView';
import { WarningTogglesPanel, type WarningToggles } from './components/WarningTogglesPanel';
import { ViewportContext } from './components/viewportContext';
import { buildPackageIdentifier, buildURL, parsePackageVersion, parseURLState, updateURL, type CompareState } from './utils/urlState';

import { enrichGraph, loadEcosystem } from './graph/ecosystems';
import { computeHighlightedGraph } from './graph/highlight';
import { fetchPackageMeta } from './api/npm';
import { layoutGraph } from './graph/layout';
import { detectManifestFileName, detectManifestUrl, fetchManifestFromUrl, parseManifestContent } from './utils/fetchManifest';
import type { GraphNodeData, ResolvedGraph } from './graph/resolver';
import { MICROPACKAGE_SIZE_THRESHOLD } from './graph/resolver';
import { buildTimelineFromVersions, type TimelineVersion } from './graph/timeline';
import { isAbortError, PermanentError } from './utils/retry';

type NodeRelationship = 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed';
type AppGraphNode = Node<Record<string, unknown> & GraphNodeData & { relationship?: NodeRelationship; searchMatch?: boolean; }>;
type AppGraphEdge = Edge;

const emptyComparisonSide = (): ComparisonSide => ({
  title: '',
  nodes: [],
  edges: [],
  isLoading: false,
  progress: { resolved: 0, total: 0 },
  loadingLabel: '',
  error: null
});

function App() {
  // Timeline mode state
  const [isTimelineMode, setIsTimelineMode] = useState(false);
  const [timelineVersions, setTimelineVersions] = useState<TimelineVersion[]>([]);

  // Comparison mode state
  const [isComparisonMode, setIsComparisonMode] = useState(false);
  const [comparisonLeftSpec, setComparisonLeftSpec] = useState<ComparisonSpec | null>(null);
  const [comparisonRightSpec, setComparisonRightSpec] = useState<ComparisonSpec | null>(null);
  const [comparisonLeftData, setComparisonLeftData] = useState<ComparisonSide>(emptyComparisonSide);
  const [comparisonRightData, setComparisonRightData] = useState<ComparisonSide>(emptyComparisonSide);
  const [fitViewSignalLeft, setFitViewSignalLeft] = useState(0);
  const [fitViewSignalRight, setFitViewSignalRight] = useState(0);

  const [searchInput, setSearchInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [warningLine, setWarningLine] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState<{ resolved: number; total: number; }>({ resolved: 0, total: 0 });
  const [loadingLabel, setLoadingLabel] = useState('');
  const [notFoundPackage, setNotFoundPackage] = useState<string | null>(null);
  const [fitViewSignal, setFitViewSignal] = useState(0);
  const [showPeerDeps, setShowPeerDeps] = useState(false);
  const [lastSearchedInput, setLastSearchedInput] = useState('');
  const [lastSearchedVersion, setLastSearchedVersion] = useState<string | undefined>(undefined);
  const [lastSearchedRegistry, setLastSearchedRegistry] = useState<'npm' | 'pypi' | 'crates' | 'go' | 'nuget'>('npm');
  const [searchRegistry, setSearchRegistry] = useState<'npm' | 'pypi' | 'crates' | 'go' | 'nuget'>('npm');
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const comparisonAbortRef = useRef<Partial<Record<'left' | 'right', AbortController>>>({});
  const timelineGraphCacheRef = useRef<Map<string, ResolvedGraph>>(new Map());
  const viewportContext = useContext(ViewportContext);
  const [copied, setCopied] = useState(false);

  const [warningToggles, setWarningToggles] = useState<WarningToggles>({
    maxDependencies: { enabled: false, value: 10 },
    singleMaintainer: false,
    prerelease: false,
    esmOnly: false,
    cjsOnly: false,
    // New visual highlights
    noRecentUpdates: { enabled: false, months: 24 },
    hasAvailableUpdates: false,
    unstableVersion: false,
    suspiciousVersion: false,
    nonOsiLicense: { enabled: false, licenses: '' },
    staleTopLevel: false
  });
  const [micropackageThreshold, setMicropackageThreshold] = useState(MICROPACKAGE_SIZE_THRESHOLD);

  // Graph search state
  const [graphSearchQuery, setGraphSearchQuery] = useState('');
  const [graphSearchInput, setGraphSearchInput] = useState('');

  const [graphData, setGraphData] = useState<{ nodes: AppGraphNode[], edges: AppGraphEdge[]; }>({
    nodes: [],
    edges: []
  });

  // Comparison mode graph generation
  const generateComparisonGraph = async (
    spec: ComparisonSpec,
    side: 'left' | 'right',
    setSideData: React.Dispatch<React.SetStateAction<ComparisonSide>>
  ) => {
    // Cancel any in-flight resolution for this side
    comparisonAbortRef.current[side]?.abort();
    const abortController = new AbortController();
    comparisonAbortRef.current[side] = abortController;
    const signal = abortController.signal;

    setSideData(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      loadingLabel: `Resolving ${spec.name || 'dependencies'}...`,
      progress: { resolved: 0, total: 1 }
    }));

    let lastProgress = { resolved: 0, total: 0 };
    const onProgress = (resolved: number, total: number) => {
      lastProgress = { resolved, total };
      setSideData(prev => ({ ...prev, progress: { resolved, total } }));
    };

    try {
      const registry = spec.source;
      const driver = await loadEcosystem(registry);

      let tree: ResolvedGraph;
      if (spec.type === 'file' && spec.fileContent) {
        // Handle file-based specs
        const manifest = parseManifestContent(spec.fileContent, registry, spec.name || 'manifest');
        if (!manifest) {
          throw new Error(`Unsupported registry: ${registry}`);
        }
        tree = await driver.resolveManifest(manifest, { showPeerDeps, signal }, onProgress);
      } else if (spec.name) {
        // Handle package specs
        tree = await driver.resolveTree(spec.name, spec.version, { showPeerDeps, signal }, onProgress);
      } else {
        throw new Error('Invalid spec: no name or file content');
      }

      setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
      await enrichGraph(driver, tree, signal);

      setSideData(prev => ({ ...prev, loadingLabel: 'Computing layout…' }));

      const layout = await layoutGraph(tree);

      setSideData({
        title: spec.name || 'Unknown',
        subtitle: spec.version ? `v${spec.version}` : undefined,
        nodes: layout.nodes,
        edges: layout.edges,
        isLoading: false,
        progress: lastProgress,
        loadingLabel: '',
        error: null
      });

      if (side === 'left') {
        setFitViewSignalLeft(s => s + 1);
      } else {
        setFitViewSignalRight(s => s + 1);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to generate graph';
      setSideData(prev => ({
        ...prev,
        isLoading: false,
        error: message
      }));
    }
  };

  const handleCompare = async () => {
    if (!comparisonLeftSpec || !comparisonRightSpec) return;

    // Update URL with comparison state
    const compareState: CompareState = {
      ecosystem: comparisonLeftSpec.source,
      oldPackage: comparisonLeftSpec.name || '',
      oldVersion: comparisonLeftSpec.version,
      newPackage: comparisonRightSpec.name || '',
      newVersion: comparisonRightSpec.version
    };
    updateURL({
      ecosystem: comparisonLeftSpec.source,
      pkg: comparisonLeftSpec.name || '',
      filters: warningToggles,
      showPeerDeps,
      version: comparisonLeftSpec.version,
      compare: compareState,
      micropackageThreshold
    });

    // Generate both graphs in parallel
    await Promise.all([
      generateComparisonGraph(comparisonLeftSpec, 'left', setComparisonLeftData),
      generateComparisonGraph(comparisonRightSpec, 'right', setComparisonRightData)
    ]);
  };

  // Restore state from URL — runs on mount and on hashchange (back/forward nav)
  function restoreFromUrl() {
    const urlState = parseURLState();
    if (urlState) {
      // Check for comparison mode first
      if (urlState.compare) {
        setIsComparisonMode(true);
        setSearchRegistry(urlState.compare.ecosystem);
        setLastSearchedRegistry(urlState.compare.ecosystem);

        // Set up left spec
        const leftSpec: ComparisonSpec = {
          type: 'package',
          source: urlState.compare.ecosystem,
          name: urlState.compare.oldPackage,
          version: urlState.compare.oldVersion
        };
        setComparisonLeftSpec(leftSpec);

        // Set up right spec
        const rightSpec: ComparisonSpec = {
          type: 'package',
          source: urlState.compare.ecosystem,
          name: urlState.compare.newPackage,
          version: urlState.compare.newVersion
        };
        setComparisonRightSpec(rightSpec);

        // Apply filters if present
        if (urlState.filters) {
          setWarningToggles(urlState.filters);
        }
        if (typeof urlState.showPeerDeps === 'boolean') {
          setShowPeerDeps(urlState.showPeerDeps);
        }
        if (urlState.micropackageThreshold) {
          setMicropackageThreshold(urlState.micropackageThreshold);
        }

        // Trigger comparison after a brief delay to let React set state
        setTimeout(() => {
          // Use the local specs directly since state updates are batched
          // and comparisonLeftSpec might not be updated yet
          const compareState = {
            ecosystem: leftSpec.source,
            oldPackage: leftSpec.name || '',
            oldVersion: leftSpec.version,
            newPackage: rightSpec.name || '',
            newVersion: rightSpec.version
          };
          updateURL({
            ecosystem: leftSpec.source,
            pkg: leftSpec.name || '',
            filters: urlState.filters,
            showPeerDeps: urlState.showPeerDeps,
            version: leftSpec.version,
            compare: compareState,
            micropackageThreshold: urlState.micropackageThreshold
          });

          // Generate both graphs using local specs, not state
          setComparisonLeftData(prev => ({ ...prev, isLoading: true, loadingLabel: 'Resolving dependencies…' }));
          setComparisonRightData(prev => ({ ...prev, isLoading: true, loadingLabel: 'Resolving dependencies…' }));

          Promise.all([
            generateComparisonGraph(leftSpec, 'left', setComparisonLeftData),
            generateComparisonGraph(rightSpec, 'right', setComparisonRightData)
          ]);
        }, 100);

        return;
      }

      if (urlState.ecosystem) {
        setSearchRegistry(urlState.ecosystem);
        setLastSearchedRegistry(urlState.ecosystem);
      }
      if (urlState.manifestUrl) {
        // Restore from manifest URL - store it for later processing
        setManifestUrl(urlState.manifestUrl);
        // Defer fetching to avoid calling function before declaration
        setTimeout(() => {
          fetchAndGraphManifest(urlState.manifestUrl!, urlState.ecosystem ?? 'npm');
        }, 0);
      } else if (urlState.package) {
        const identifier = buildPackageIdentifier(urlState.package, urlState.version);
        setSearchInput(identifier);
        setLastSearchedInput(urlState.package);
        setLastSearchedVersion(urlState.version);
      }
      if (urlState.filters) {
        setWarningToggles(urlState.filters);
      }
      if (typeof urlState.showPeerDeps === 'boolean') {
        setShowPeerDeps(urlState.showPeerDeps);
      }
      if (urlState.micropackageThreshold) {
        setMicropackageThreshold(urlState.micropackageThreshold);
      }
      // Generate graph for restored package (if not from manifest)
      if (urlState.ecosystem && urlState.package && !urlState.manifestUrl) {
        generateGraph(urlState.package, urlState.ecosystem, urlState.version, urlState.showPeerDeps);
      }
    }
  }

  useEffect(() => {
    restoreFromUrl();
    // history.replaceState doesn't fire hashchange, so this only runs
    // on real back/forward navigation or manual hash edits
    window.addEventListener('hashchange', restoreFromUrl);
    return () => window.removeEventListener('hashchange', restoreFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update URL when ecosystem/package/filters change
  useEffect(() => {
    // Don't update URL during comparison mode - comparison has its own URL format
    if (isComparisonMode) return;

    if (lastSearchedInput && lastSearchedRegistry) {
      const viewport = viewportContext?.getViewport();
      updateURL({
        ecosystem: lastSearchedRegistry,
        pkg: lastSearchedInput,
        filters: warningToggles,
        viewport: viewport ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom } : undefined,
        showPeerDeps,
        version: lastSearchedVersion,
        manifestUrl: manifestUrl || undefined,
        micropackageThreshold
      });
    }
  }, [lastSearchedInput, lastSearchedRegistry, lastSearchedVersion, warningToggles, viewportContext, showPeerDeps, manifestUrl, isComparisonMode, micropackageThreshold]);

  // Throttled viewport updates to URL
  useEffect(() => {
    if (!viewportContext || !lastSearchedInput || isComparisonMode) return;

    const interval = setInterval(() => {
      const viewport = viewportContext.getViewport();
      const url = buildURL({
        ecosystem: lastSearchedRegistry,
        pkg: lastSearchedInput,
        filters: warningToggles,
        viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
        showPeerDeps,
        version: lastSearchedVersion,
        manifestUrl: manifestUrl || undefined,
        micropackageThreshold
      });
      // Skip the replaceState when the encoded state hasn't changed —
      // avoids a history write every 500ms while the viewport is idle
      if (window.location.hash !== url) {
        window.history.replaceState(null, '', url);
      }
    }, 500); // Update every 500ms

    return () => clearInterval(interval);
  }, [viewportContext, lastSearchedInput, lastSearchedRegistry, lastSearchedVersion, warningToggles, showPeerDeps, manifestUrl, isComparisonMode, micropackageThreshold]);

  const makeProgressCallback = (label: string) => {
    setLoadingLabel(label);
    setProgress({ resolved: 0, total: 0 });
    return (resolved: number, total: number) => {
      setProgress({ resolved, total });
    };
  };

  // Shared tail of every graph-load path: surface resolution issues, run
  // enrichment passes, compute the layout, and publish the graph.
  const layoutResolvedTree = async (
    driver: Awaited<ReturnType<typeof loadEcosystem>>,
    tree: ResolvedGraph,
    signal: AbortSignal
  ) => {
    if (tree.errors.length > 0) {
      console.warn('Dependency resolution had errors:', tree.errors);
    }
    if (tree.cycles.length > 0) {
      console.warn('Dependency cycles detected:', tree.cycles);
      setWarningLine(`Detected ${tree.cycles.length} dependency cycle${tree.cycles.length === 1 ? '' : 's'}.`);
    }
    setLoadingLabel('Enriching with deps.dev metadata…');
    await enrichGraph(driver, tree, signal);
    setLoadingLabel('Computing layout…');
    const layout = await layoutGraph(tree);
    setGraphData(layout);
    setSelectedNode(null);
    setFitViewSignal(s => s + 1);
  };

  const generateGraph = async (identifier: string, registry: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget' = 'npm', version?: string, overrideShowPeerDeps?: boolean) => {
    // Cancel previous search if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsLoading(true);
    setErrorLine(null);
    setWarningLine(null);
    setNotFoundPackage(null);
    setLoadingLabel(`Resolving ${identifier}...`);
    setProgress({ resolved: 0, total: 1 });

    const signal = abortController.signal;

    try {
      const onProgress = makeProgressCallback(`Resolving ${identifier}`);

      const usePeerDeps = overrideShowPeerDeps ?? showPeerDeps;
      const driver = await loadEcosystem(registry);
      const tree = await driver.resolveTree(identifier, version, { showPeerDeps: usePeerDeps, signal }, onProgress);
      await layoutResolvedTree(driver, tree, signal);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return;
      }
      if (err instanceof PermanentError) {
        setNotFoundPackage(identifier);
        return;
      }
      console.error(err);
      const message = err instanceof Error ? err.message : 'Failed to generate graph. Check console.';
      setErrorLine(message);
    } finally {
      // Only clear loading if this search is still the current one — a
      // superseded search must not hide the newer one's progress
      if (abortControllerRef.current === abortController) {
        setIsLoading(false);
      }
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchInput.trim()) return;

    const trimmed = searchInput.trim();

    // Exit comparison mode if active
    if (isComparisonMode) {
      setIsComparisonMode(false);
      setComparisonLeftSpec(null);
      setComparisonRightSpec(null);
      setComparisonLeftData(emptyComparisonSide());
      setComparisonRightData(emptyComparisonSide());
      // Clear the URL hash
      window.history.replaceState(null, '', '#');
    }

    // Check if input is a URL to a manifest file
    const detectedManifest = detectManifestUrl(trimmed);
    if (detectedManifest) {
      await fetchAndGraphManifest(detectedManifest.url, detectedManifest.type);
      return;
    }

    // Clear manifest URL when doing a regular package search
    setManifestUrl(null);

    const { name, version } = parsePackageVersion(trimmed);
    setLastSearchedInput(name);
    setLastSearchedVersion(version);
    setLastSearchedRegistry(searchRegistry);
    await generateGraph(name, searchRegistry, version);
  };

  const fetchAndGraphManifest = async (url: string, type: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget') => {
    setIsLoading(true);
    setErrorLine(null);
    setWarningLine(null);
    setLoadingLabel(`Fetching manifest from ${type}...`);
    setProgress({ resolved: 0, total: 1 });
    setManifestUrl(url);

    // Cancel previous search if any — do this before fetching so a stale
    // manifest download can't outlive a newer request
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

    try {
      const manifest = await fetchManifestFromUrl(url, type, signal);
      if (!manifest) {
        throw new Error('Failed to parse manifest');
      }

      const onProgress = makeProgressCallback(`Resolving ${manifest.data.name}`);

      setLastSearchedRegistry(manifest.type);
      setSearchInput(manifest.type === 'npm'
        ? buildPackageIdentifier(manifest.data.name, manifest.data.version)
        : manifest.data.name);
      setLastSearchedInput(manifest.data.name);
      // requirements.txt manifests carry a synthetic 'remote' version, not a real one
      setLastSearchedVersion(manifest.type === 'pypi' ? undefined : manifest.data.version);

      const driver = await loadEcosystem(manifest.type);
      const tree = await driver.resolveManifest(manifest, { showPeerDeps, signal }, onProgress);
      await layoutResolvedTree(driver, tree, signal);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to fetch or parse manifest.';
      setErrorLine(message);
    } finally {
      if (abortControllerRef.current === abortController) {
        setIsLoading(false);
      }
    }
  };

  const handleCopyView = async () => {
    if (!lastSearchedInput) return;
    const viewport = viewportContext?.getViewport();
    const url = buildURL({
      ecosystem: lastSearchedRegistry,
      pkg: lastSearchedInput,
      filters: warningToggles,
      viewport: viewport ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom } : undefined,
      showPeerDeps,
      version: lastSearchedVersion,
      manifestUrl: manifestUrl || undefined,
      micropackageThreshold
    });
    const fullUrl = window.location.origin + url;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleNodeClick = useCallback((nodeId: string | null) => {
    setSelectedNode(nodeId);
  }, []);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setIsDragging(true);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) {
        setIsDragging(false);
      }
    };

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      // Exit comparison mode if active
      if (isComparisonMode) {
        setIsComparisonMode(false);
        setComparisonLeftSpec(null);
        setComparisonRightSpec(null);
        setComparisonLeftData(emptyComparisonSide());
        setComparisonRightData(emptyComparisonSide());
        // Clear the URL hash
        window.history.replaceState(null, '', '#');
      }

      // Cancel any in-flight resolution before starting a new one
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const signal = abortController.signal;

      const file = e.dataTransfer?.files?.[0];
      const fileType = file ? detectManifestFileName(file.name) : null;
      if (file && fileType) {
        try {
          const text = await file.text();
          const manifest = parseManifestContent(text, fileType, file.name);
          if (!manifest) {
            throw new Error(`Failed to parse ${file.name}`);
          }

          setLastSearchedRegistry(fileType);
          setSearchInput(fileType === 'npm'
            ? buildPackageIdentifier(manifest.data.name, manifest.data.version)
            : manifest.data.name);
          setLastSearchedInput(manifest.data.name);
          // requirements.txt manifests carry a synthetic 'remote' version, not a real one
          setLastSearchedVersion(fileType === 'pypi' ? undefined : manifest.data.version);
          setIsLoading(true);
          setErrorLine(null);
          setWarningLine(null);

          const onProgress = makeProgressCallback(`Resolving ${manifest.data.name}`);
          try {
            const driver = await loadEcosystem(fileType);
            const tree = await driver.resolveManifest(manifest, { showPeerDeps, signal }, onProgress);
            await layoutResolvedTree(driver, tree, signal);
            // Clear URL so refresh doesn't reload
            window.history.replaceState(null, '', '#');
          } catch (err: unknown) {
            if (!isAbortError(err)) {
              const message = err instanceof Error ? err.message : 'Failed to generate graph.';
              setErrorLine(message);
            }
          } finally {
            if (abortControllerRef.current === abortController) {
              setIsLoading(false);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : `Failed to parse ${file.name}.`;
          setErrorLine(message);
          setWarningLine(null);
        }
      } else if (file) {
        setErrorLine('Please drop a valid package.json, requirements.txt, Cargo.toml, go.mod, or .csproj file.');
        setWarningLine(null);
      }
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComparisonMode]);


  // Make sure we pass the full node data to Sidebar
  const selectedNodeData = graphData.nodes.find(n => n.id === selectedNode)?.data || null;

  const highlightedGraphData = useMemo(
    () => computeHighlightedGraph({
      nodes: graphData.nodes,
      edges: graphData.edges,
      selectedNode,
      warningToggles,
      graphSearchQuery,
      micropackageThreshold
    }),
    [graphData, selectedNode, warningToggles, graphSearchQuery, micropackageThreshold]
  );

  return (
    <div className="app-container">
      {/* Drop overlay */}
      {isDragging && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          backdropFilter: 'blur(4px)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '4px dashed var(--accent-blue)', borderRadius: '16px', margin: '16px'
        }}>
          <h2 style={{ color: 'white', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>Drop package.json, requirements.txt, Cargo.toml, go.mod, or .csproj here</h2>
        </div>
      )}

      {/* Header Area */}
      <header className="app-header glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Package size={28} color="var(--accent-blue)" />
          <h1 className="gradient-text" style={{ fontSize: '20px', margin: 0 }}>Undergrowth</h1>
        </div>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', flex: 1, maxWidth: '800px', margin: '0 24px', flexDirection: 'column', position: 'relative' }}>
          <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
            <div style={{ position: 'relative', width: '100%' }}>
              <div style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>
                <Search size={18} />
              </div>
              <input
                type="text"
                className="glass-input"
                style={{ paddingLeft: '40px' }}
                placeholder="Package (react@18.2.0) or manifest URL (package.json, requirements.txt, Cargo.toml, go.mod, .csproj)..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <button type="submit" className="primary" disabled={isLoading}>
              {isLoading ? 'Loading...' : 'Graph It'}
            </button>
            <select
              value={searchRegistry}
              onChange={e => setSearchRegistry(e.target.value as 'npm' | 'pypi' | 'crates' | 'go' | 'nuget')}
              disabled={isLoading}
              style={{
                background: 'var(--glass-bg)',
                border: '1px solid var(--glass-border)',
                borderRadius: '8px',
                padding: '8px 28px 8px 12px',
                color: 'var(--text-primary)',
                fontSize: '13px',
                cursor: 'pointer',
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                minWidth: '100px'
              }}
            >
              <option value="npm" style={{ background: '#1e293b', color: '#f8fafc' }}>
                npm
              </option>
              <option value="pypi" style={{ background: '#1e293b', color: '#22d3ee' }}>
                PyPI
              </option>
              <option value="crates" style={{ background: '#1e293b', color: '#fbbf24' }}>
                Rust
              </option>
              <option value="go" style={{ background: '#1e293b', color: '#53ceec' }}>
                Go
              </option>
              <option value="nuget" style={{ background: '#1e293b', color: '#a389ff' }}>
                NuGet
              </option>
            </select>
            <label style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              fontSize: '13px', color: 'var(--text-secondary)',
              cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={showPeerDeps}
                onChange={async e => {
                  const checked = e.target.checked;
                  setShowPeerDeps(checked);
                  if (searchInput.trim() && searchInput.trim() === buildPackageIdentifier(lastSearchedInput, lastSearchedVersion)) {
                    if (lastSearchedRegistry === 'npm' || lastSearchedRegistry === 'crates') {
                      await generateGraph(lastSearchedInput, lastSearchedRegistry, lastSearchedVersion, checked);
                    }
                  }
                }}
                style={{ accentColor: 'var(--accent-purple)', width: '14px', height: '14px', cursor: 'pointer' }}
              />
              Optional deps
            </label>
            <button
              type="button"
              onClick={() => {
                setIsComparisonMode(!isComparisonMode);
                // Exit timeline mode when entering comparison mode
                if (isTimelineMode) {
                  setIsTimelineMode(false);
                }
              }}
              title={isComparisonMode ? 'Exit comparison mode' : 'Compare versions'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: isComparisonMode ? 'var(--accent-blue)' : 'var(--glass-bg)',
                border: '1px solid var(--glass-border)',
                borderRadius: '6px',
                color: isComparisonMode ? 'white' : 'var(--text-secondary)',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap'
              }}
            >
              <GitCompare size={16} />
              Compare
            </button>
            <button
              type="button"
              onClick={async () => {
                // Only support npm for now
                if (!lastSearchedInput || lastSearchedRegistry !== 'npm') {
                  setErrorLine('Timeline mode currently only supports npm packages');
                  return;
                }
                try {
                  setIsLoading(true);
                  const meta = await fetchPackageMeta(lastSearchedInput);
                  const timeline = buildTimelineFromVersions(meta.versions, meta.time);
                  setTimelineVersions(timeline);
                  timelineGraphCacheRef.current.clear();
                  setIsTimelineMode(true);
                  setErrorLine(null);
                } catch (err) {
                  setErrorLine(err instanceof Error ? err.message : 'Failed to fetch package history');
                } finally {
                  setIsLoading(false);
                }
              }}
              disabled={!lastSearchedInput || lastSearchedRegistry !== 'npm' || isLoading}
              title={lastSearchedRegistry !== 'npm' ? 'Timeline mode currently only supports npm' : 'View historical timeline'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: isTimelineMode ? 'var(--accent-purple)' : 'var(--glass-bg)',
                border: '1px solid var(--glass-border)',
                borderRadius: '6px',
                color: isTimelineMode ? 'white' : 'var(--text-secondary)',
                fontSize: '13px',
                cursor: (!lastSearchedInput || lastSearchedRegistry !== 'npm' || isLoading) ? 'not-allowed' : 'pointer',
                opacity: (!lastSearchedInput || lastSearchedRegistry !== 'npm') ? 0.5 : 1,
                transition: 'all 0.2s',
                whiteSpace: 'nowrap'
              }}
            >
              <History size={16} />
              Timeline
            </button>
          </div>
          {errorLine && (
            <div style={{ position: 'absolute', top: '100%', left: 0, color: 'var(--accent-rose)', fontSize: '12px', marginTop: '4px' }}>
              {errorLine}
            </div>
          )}
          {!errorLine && warningLine && (
            <div style={{ position: 'absolute', top: '100%', left: 0, color: 'var(--accent-amber)', fontSize: '12px', marginTop: '4px' }}>
              {warningLine}
            </div>
          )}
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={handleCopyView}
            disabled={!lastSearchedInput}
            title="Copy view URL"
            style={{
              background: 'none',
              border: 'none',
              cursor: lastSearchedInput ? 'pointer' : 'not-allowed',
              color: copied ? 'var(--accent-emerald)' : 'var(--text-muted)',
              display: 'flex',
              padding: '4px',
              transition: 'color 150ms ease' }}
          >
            {copied ? <Check size={22} /> : <Copy size={22} />}
          </button>
          <a href="https://github.com/knackstedt/undergrowth" target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)', display: 'flex' }}>
            <Github size={24} />
          </a>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="app-main">
        {isTimelineMode ? (
          <TimelineView
            packageName={lastSearchedInput}
            registry={lastSearchedRegistry}
            versions={timelineVersions}
            fetchGraphForVersion={async (version) => {
              const cached = timelineGraphCacheRef.current.get(version);
              if (cached) return cached;
              const driver = await loadEcosystem('npm');
              const graph = await driver.resolveTree(lastSearchedInput, version, { showPeerDeps });
              timelineGraphCacheRef.current.set(version, graph);
              return graph;
            }}
            onClose={() => setIsTimelineMode(false)}
          />
        ) : isComparisonMode ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
            {!comparisonLeftData.nodes.length && !comparisonRightData.nodes.length ? (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px'
              }}>
                <div style={{ maxWidth: '800px', width: '100%' }}>
                  <ComparisonInput
                    left={comparisonLeftSpec}
                    right={comparisonRightSpec}
                    onLeftChange={setComparisonLeftSpec}
                    onRightChange={setComparisonRightSpec}
                    onCompare={handleCompare}
                    isLoading={comparisonLeftData.isLoading || comparisonRightData.isLoading}
                  />
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, position: 'relative' }}>
                <ComparisonView
                  left={comparisonLeftData}
                  right={comparisonRightData}
                  fitViewSignalLeft={fitViewSignalLeft}
                  fitViewSignalRight={fitViewSignalRight}
                />
                <button
                  onClick={() => {
                    setComparisonLeftData(emptyComparisonSide());
                    setComparisonRightData(emptyComparisonSide());
                    setComparisonLeftSpec(null);
                    setComparisonRightSpec(null);
                    // Clear the URL hash
                    window.history.replaceState(null, '', '#');
                  }}
                  style={{
                    position: 'absolute',
                    top: '36px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 100,
                    padding: '8px 16px',
                    background: '#181a1d78',
                    border: '0',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    cursor: 'pointer',
                    backdropFilter: 'blur(10px)'
                  }}
                >
                  Compare Different Versions
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="app-graph-area">
            <GraphView
              nodes={highlightedGraphData.nodes}
              edges={highlightedGraphData.edges}
              onNodeClick={handleNodeClick}
              fitViewSignal={fitViewSignal}
            />
            <LoadingOverlay
              isVisible={isLoading}
              resolved={progress.resolved}
              total={progress.total}
              label={loadingLabel}
            />
            <Legend />
            {/* Graph Search Input */}
            {graphData.nodes.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '24px',
                right: '88px',
                zIndex: 50,
                display: 'flex',
                alignItems: 'center',
                gap: '8px' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'var(--glass-bg)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '8px',
                  padding: '8px 12px' }}>
                  <Search size={16} color="var(--text-muted)" />
                  <input
                    type="text"
                    placeholder="Find in graph..."
                    value={graphSearchInput}
                    onChange={(e) => {
                      setGraphSearchInput(e.target.value);
                      setGraphSearchQuery(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setGraphSearchInput('');
                        setGraphSearchQuery('');
                      }
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      width: '140px' }}
                  />
                  {graphSearchInput && (
                    <button
                      onClick={() => {
                        setGraphSearchInput('');
                        setGraphSearchQuery('');
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        padding: '2px' }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {graphSearchQuery && (
                  <span style={{
                    fontSize: '12px',
                    color: 'var(--text-muted)' }}>
                    {graphData.nodes.filter(n => n.data.pkgName.toLowerCase().includes(graphSearchQuery.toLowerCase())).length} matches
                  </span>
                )}
              </div>
            )}
            <WarningTogglesPanel
              toggles={warningToggles}
              onToggleChange={setWarningToggles}
              micropackageThreshold={micropackageThreshold}
              onMicropackageThresholdChange={setMicropackageThreshold}
            />
          </div>
        )}

        {/* Sidebar overlay - only show in single view mode */}
        {!isComparisonMode && !isTimelineMode && (
          <SidebarInfo
            nodeId={selectedNode}
            nodeData={selectedNodeData}
            micropackageThreshold={micropackageThreshold}
            isOpen={!!selectedNode}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </main>

      {/* Package not found dialog */}
      {notFoundPackage && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setNotFoundPackage(null)}
        >
          <div
            className="glass-panel"
            onClick={e => e.stopPropagation()}
            style={{
              padding: '32px', borderRadius: '16px', maxWidth: '420px', width: '90%',
              border: '1px solid var(--accent-rose)', position: 'relative' }}
          >
            <button
              onClick={() => setNotFoundPackage(null)}
              style={{
                position: 'absolute', top: '16px', right: '16px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', display: 'flex', padding: '4px' }}
            >
              <X size={18} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <Package size={28} color="var(--accent-rose)" />
              <div>
                <div style={{ fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>Package not found</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>{lastSearchedRegistry} registry returned 404</div>
              </div>
            </div>
            <div style={{
              padding: '12px 16px', borderRadius: '8px',
              background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
              fontFamily: 'monospace', fontSize: '14px', color: 'var(--accent-rose)',
              marginBottom: '20px' }}>
              {notFoundPackage}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0 }}>
              Check the spelling and try again. Private or scoped packages may require authentication.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
