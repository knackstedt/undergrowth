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

import { parseGoMod } from './api/go';
import { fetchPackageMeta } from './api/npm';
import { parseRequirementsTxt } from './api/pypi';
import { layoutGraph } from './graph/layout';
import {resolvePythonDependencyTreeFromManifest} from './graph/python-resolver';
import type { GraphNodeData } from './graph/resolver';
import {enrichGraphWithDepsDevData, resolveDependencyTree} from './graph/resolver';
import { buildTimelineFromVersions, type TimelineVersion } from './graph/timeline';
import { detectManifestUrl, fetchManifestFromUrl } from './utils/fetchManifest';
import { PermanentError } from './utils/retry';

type NodeRelationship = 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed';
type AppGraphNode = Node<Record<string, unknown> & GraphNodeData & { relationship?: NodeRelationship; searchMatch?: boolean; }>;
type AppGraphEdge = Edge;

function App() {
  // Timeline mode state
  const [isTimelineMode, setIsTimelineMode] = useState(false);
  const [timelineVersions, setTimelineVersions] = useState<TimelineVersion[]>([]);

  // Comparison mode state
  const [isComparisonMode, setIsComparisonMode] = useState(false);
  const [comparisonLeftSpec, setComparisonLeftSpec] = useState<ComparisonSpec | null>(null);
  const [comparisonRightSpec, setComparisonRightSpec] = useState<ComparisonSpec | null>(null);
  const [comparisonLeftData, setComparisonLeftData] = useState<ComparisonSide>({
    title: '',
    nodes: [],
    edges: [],
    isLoading: false,
    progress: { resolved: 0, total: 0 },
    loadingLabel: '',
    error: null
  });
  const [comparisonRightData, setComparisonRightData] = useState<ComparisonSide>({
    title: '',
    nodes: [],
    edges: [],
    isLoading: false,
    progress: { resolved: 0, total: 0 },
    loadingLabel: '',
    error: null
  });
  const [fitViewSignalLeft, setFitViewSignalLeft] = useState(0);
  const [fitViewSignalRight, setFitViewSignalRight] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_comparisonSelectedNode, setComparisonSelectedNode] = useState<{ side: 'left' | 'right'; nodeId: string } | null>(null);
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
  const [micropackageThreshold, setMicropackageThreshold] = useState(6144);

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
    setSideData(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      loadingLabel: `Resolving ${spec.name || 'dependencies'}...`,
      progress: { resolved: 0, total: 1 }
    }));

    const onProgress = (resolved: number, total: number) => {
      setSideData(prev => ({ ...prev, progress: { resolved, total } }));
    };

    try {
      let tree;
      const registry = spec.source;

      if (spec.type === 'file' && spec.fileContent) {
        // Handle file-based specs
        if (registry === 'npm') {
          const pkg = JSON.parse(spec.fileContent);
          const { resolveDependencyTreeFromManifest } = await import('./graph/resolver');
          tree = await resolveDependencyTreeFromManifest(pkg, { showPeerDeps }, onProgress);
        } else if (registry === 'pypi') {
          const {resolvePythonDependencyTreeFromManifest, enrichPythonGraphWithDepsDevData} = await import('./graph/python-resolver');
          const deps = parseRequirementsTxt(spec.fileContent);
          const manifest = {
            name: spec.name || 'requirements',
            version: 'local',
            description: `Python requirements`,
            dependencies: Object.fromEntries(deps.filter(d => d.source === 'pypi').map(d => [d.name, d.specifier || '*']))
          };
          tree = await resolvePythonDependencyTreeFromManifest(manifest, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichPythonGraphWithDepsDevData(tree);
        } else if (registry === 'go') {
          const {resolveGoDependencyTreeFromManifest, enrichGoGraphWithDepsDevData} = await import('./graph/go-resolver');
          const deps = parseGoMod(spec.fileContent);
          const directDeps = deps.filter(d => !d.indirect);
          const manifest = {
            name: spec.name || 'go-module',
            version: 'local',
            description: `Go module`,
            dependencies: Object.fromEntries(directDeps.map(d => [d.path, d.version]))
          };
          tree = await resolveGoDependencyTreeFromManifest(manifest, { showPeerDeps }, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichGoGraphWithDepsDevData(tree);
        } else if (registry === 'crates') {
          const {resolveRustDependencyTreeFromManifest, enrichRustGraphWithDepsDevData} = await import('./graph/rust-resolver');
          // Parse Cargo.toml - simplified
          const nameMatch = spec.fileContent.match(/name\s*=\s*"([^"]+)"/);
          const versionMatch = spec.fileContent.match(/version\s*=\s*"([^"]+)"/);
          const depsMatch = spec.fileContent.match(/\[dependencies\]([^[]*)/);
          const deps: Record<string, string> = {};
          if (depsMatch) {
            const depLines = depsMatch[1].trim().split('\n');
            for (const line of depLines) {
              const match = line.match(/(\S+)\s*=\s*"([^"]+)"/);
              if (match) deps[match[1]] = match[2];
            }
          }
          const manifest = {
            name: nameMatch?.[1] || spec.name || 'rust-package',
            version: versionMatch?.[1] || 'local',
            dependencies: deps
          };
          tree = await resolveRustDependencyTreeFromManifest(manifest, { showPeerDeps }, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichRustGraphWithDepsDevData(tree);
        } else if (registry === 'nuget') {
          const {resolveCSharpDependencyTreeFromManifest, enrichCSharpGraphWithDepsDevData} = await import('./graph/csharp-resolver');
          const parser = new DOMParser();
          const doc = parser.parseFromString(spec.fileContent, 'application/xml');
          const packageId = doc.querySelector('PackageId')?.textContent || spec.name || 'csharp-package';
          const version = doc.querySelector('Version')?.textContent || 'local';
          const packageRefs = Array.from(doc.querySelectorAll('PackageReference'));
          const deps: Record<string, string> = {};
          for (const ref of packageRefs) {
            const include = ref.getAttribute('Include');
            const versionAttr = ref.getAttribute('Version') || ref.querySelector('Version')?.textContent;
            if (include && versionAttr) deps[include] = versionAttr;
          }
          const manifest = { name: packageId, version, dependencies: deps };
          tree = await resolveCSharpDependencyTreeFromManifest(manifest, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichCSharpGraphWithDepsDevData(tree);
        } else {
          throw new Error(`Unsupported registry: ${registry}`);
        }
      } else if (spec.name) {
        // Handle package specs
        const version = spec.version;
        if (registry === 'pypi') {
          const {resolvePythonDependencyTree, enrichPythonGraphWithDepsDevData} = await import('./graph/python-resolver');
          tree = await resolvePythonDependencyTree(spec.name, version || '*', onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichPythonGraphWithDepsDevData(tree);
        } else if (registry === 'crates') {
          const {resolveRustDependencyTree, enrichRustGraphWithDepsDevData} = await import('./graph/rust-resolver');
          tree = await resolveRustDependencyTree(spec.name, version || '*', { showPeerDeps }, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichRustGraphWithDepsDevData(tree);
        } else if (registry === 'go') {
          const {resolveGoDependencyTree, enrichGoGraphWithDepsDevData} = await import('./graph/go-resolver');
          tree = await resolveGoDependencyTree(spec.name, version || 'latest', { showPeerDeps }, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichGoGraphWithDepsDevData(tree);
        } else if (registry === 'nuget') {
          const {resolveCSharpDependencyTree, enrichCSharpGraphWithDepsDevData} = await import('./graph/csharp-resolver');
          tree = await resolveCSharpDependencyTree(spec.name, version || '*', undefined, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichCSharpGraphWithDepsDevData(tree);
        } else {
          // NPM
          const {resolveDependencyTree, enrichGraphWithDepsDevData} = await import('./graph/resolver');
          tree = await resolveDependencyTree(spec.name, version, { showPeerDeps }, onProgress);
          setSideData(prev => ({ ...prev, loadingLabel: 'Enriching with deps.dev metadata…' }));
          await enrichGraphWithDepsDevData(tree);
        }
      } else {
        throw new Error('Invalid spec: no name or file content');
      }

      setSideData(prev => ({ ...prev, loadingLabel: 'Computing layout…' }));

      // DEBUG: Check tree node IDs before layout
      const treeIds = [...tree.nodes.keys()].slice(0, 5);
      console.log(`[generateComparisonGraph] side=${side}, tree node IDs BEFORE layout:`, treeIds);

      const layout = await layoutGraph(tree);

      // DEBUG: Log generated node IDs
      console.log(`[generateComparisonGraph] side=${side}, generated ${layout.nodes.length} nodes. Sample IDs:`, layout.nodes.slice(0, 5).map((n: AppGraphNode) => n.id));

      setSideData({
        title: spec.name || 'Unknown',
        subtitle: spec.version ? `v${spec.version}` : undefined,
        nodes: layout.nodes,
        edges: layout.edges,
        isLoading: false,
        progress: { resolved: tree.resolvedCount, total: tree.totalCount },
        loadingLabel: '',
        error: null
      });

      if (side === 'left') {
        setFitViewSignalLeft(s => s + 1);
      } else {
        setFitViewSignalRight(s => s + 1);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Aborted') {
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
    updateURL(
      comparisonLeftSpec.source,
      comparisonLeftSpec.name || '',
      warningToggles,
      undefined,
      showPeerDeps,
      comparisonLeftSpec.version,
      undefined,
      compareState,
      micropackageThreshold
    );

    // Generate both graphs in parallel
    await Promise.all([
      generateComparisonGraph(comparisonLeftSpec, 'left', setComparisonLeftData),
      generateComparisonGraph(comparisonRightSpec, 'right', setComparisonRightData)
    ]);
  };

  const handleComparisonNodeClick = useCallback((side: 'left' | 'right', nodeId: string | null) => {
    if (nodeId) {
      setComparisonSelectedNode({ side, nodeId });
    } else {
      setComparisonSelectedNode(null);
    }
  }, []);

  // Restore state from URL on mount
  useEffect(() => {
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
          updateURL(
            leftSpec.source,
            leftSpec.name || '',
            urlState.filters,
            undefined,
            urlState.showPeerDeps,
            leftSpec.version,
            undefined,
            compareState,
            urlState.micropackageThreshold
          );

          // Generate both graphs using local specs, not state
          setComparisonLeftData(prev => ({ ...prev, isLoading: true, loadingLabel: 'Resolving dependencies…' }));
          setComparisonRightData(prev => ({ ...prev, isLoading: true, loadingLabel: 'Resolving dependencies…' }));

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
          fetchAndGraphManifest(urlState.manifestUrl!, urlState.ecosystem);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update URL when ecosystem/package/filters change
  useEffect(() => {
    // Don't update URL during comparison mode - comparison has its own URL format
    if (isComparisonMode) return;

    if (lastSearchedInput && lastSearchedRegistry) {
      const viewport = viewportContext?.getViewport();
      updateURL(
        lastSearchedRegistry,
        lastSearchedInput,
        warningToggles,
        viewport ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom } : undefined,
        showPeerDeps,
        lastSearchedVersion,
        manifestUrl || undefined,
        undefined,
        micropackageThreshold
      );
    }
  }, [lastSearchedInput, lastSearchedRegistry, lastSearchedVersion, warningToggles, viewportContext, showPeerDeps, manifestUrl, isComparisonMode, micropackageThreshold]);

  // Throttled viewport updates to URL
  useEffect(() => {
    if (!viewportContext || !lastSearchedInput || isComparisonMode) return;

    const interval = setInterval(() => {
      const viewport = viewportContext.getViewport();
      updateURL(
        lastSearchedRegistry,
        lastSearchedInput,
        warningToggles,
        { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
        showPeerDeps,
        lastSearchedVersion,
        manifestUrl || undefined,
        undefined,
        micropackageThreshold
      );
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

    try {
      const onProgress = makeProgressCallback(`Resolving ${identifier}`);
      
      if (registry === 'pypi') {
        // Use Python resolver
        const { resolvePythonDependencyTree } = await import('./graph/python-resolver');
        const tree = await resolvePythonDependencyTree(identifier, version || '*', onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        const { enrichPythonGraphWithDepsDevData } = await import('./graph/python-resolver');
        await enrichPythonGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setFitViewSignal(s => s + 1);
        setSelectedNode(null);
      } else if (registry === 'crates') {
        // Use Rust resolver
        const {resolveRustDependencyTree, enrichRustGraphWithDepsDevData} = await import('./graph/rust-resolver');
        const usePeerDeps = overrideShowPeerDeps ?? showPeerDeps;
        const tree = await resolveRustDependencyTree(identifier, version || '*', { showPeerDeps: usePeerDeps }, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        await enrichRustGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setFitViewSignal(s => s + 1);
        setSelectedNode(null);
      } else if (registry === 'go') {
        // Use Go resolver
        const {resolveGoDependencyTree, enrichGoGraphWithDepsDevData} = await import('./graph/go-resolver');
        const usePeerDeps = overrideShowPeerDeps ?? showPeerDeps;
        const tree = await resolveGoDependencyTree(identifier, version || 'latest', { showPeerDeps: usePeerDeps }, onProgress);
        // Filter out "no versions found" errors - these are expected for stdlib and private packages
        const significantErrors = tree.errors.filter(e => !e.error.includes('no versions found'));
        if (significantErrors.length > 0) {
          console.warn('Dependency resolution had errors:', significantErrors);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        await enrichGoGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setFitViewSignal(s => s + 1);
        setSelectedNode(null);
      } else if (registry === 'nuget') {
        // Use C# / NuGet resolver
        const {resolveCSharpDependencyTree, enrichCSharpGraphWithDepsDevData} = await import('./graph/csharp-resolver');
        const tree = await resolveCSharpDependencyTree(identifier, version || '*', undefined, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        await enrichCSharpGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setFitViewSignal(s => s + 1);
        setSelectedNode(null);
      } else {
        // Use NPM resolver
        const usePeerDeps = overrideShowPeerDeps ?? showPeerDeps;
        const tree = await resolveDependencyTree(identifier, version, { showPeerDeps: usePeerDeps }, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        if (tree.cycles.length > 0) {
          console.warn('Dependency cycles detected:', tree.cycles);
          setWarningLine(`Detected ${tree.cycles.length} dependency cycle${tree.cycles.length === 1 ? '' : 's'}.`);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        await enrichGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setFitViewSignal(s => s + 1);
        setSelectedNode(null);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Aborted') {
        console.log('Search aborted:', identifier);
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
      setIsLoading(false);
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
      setComparisonLeftData({
        title: '',
        nodes: [],
        edges: [],
        isLoading: false,
        progress: { resolved: 0, total: 0 },
        loadingLabel: '',
        error: null
      });
      setComparisonRightData({
        title: '',
        nodes: [],
        edges: [],
        isLoading: false,
        progress: { resolved: 0, total: 0 },
        loadingLabel: '',
        error: null
      });
      setComparisonSelectedNode(null);
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

    try {
      const manifest = await fetchManifestFromUrl(url, type);
      if (!manifest) {
        throw new Error('Failed to parse manifest');
      }

      // Cancel previous search if any
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const onProgress = makeProgressCallback(`Resolving ${manifest.data.name}`);

      if (manifest.type === 'npm') {
        setLastSearchedRegistry('npm');
        const identifier = buildPackageIdentifier(manifest.data.name, manifest.data.version);
        setSearchInput(identifier);
        setLastSearchedInput(manifest.data.name);
        setLastSearchedVersion(manifest.data.version);

        const { resolveDependencyTreeFromManifest } = await import('./graph/resolver');
        const tree = await resolveDependencyTreeFromManifest({
          name: manifest.data.name,
          version: manifest.data.version || '0.0.0',
          description: manifest.data.description || '',
          dependencies: manifest.data.dependencies,
          devDependencies: manifest.data.devDependencies,
          peerDependencies: manifest.data.peerDependencies
        }, { showPeerDeps }, onProgress);

        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        if (tree.cycles.length > 0) {
          setWarningLine(`Detected ${tree.cycles.length} dependency cycle${tree.cycles.length === 1 ? '' : 's'}.`);
        }
        setLoadingLabel('Enriching with deps.dev metadata…');
        await enrichGraphWithDepsDevData(tree);
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setSelectedNode(null);
      } else if (manifest.type === 'pypi') {
        setLastSearchedRegistry('pypi');
        setSearchInput(manifest.data.name);
        setLastSearchedInput(manifest.data.name);
        setLastSearchedVersion(undefined);

        const tree = await resolvePythonDependencyTreeFromManifest(manifest.data, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setSelectedNode(null);
      } else if (manifest.type === 'crates') {
        setLastSearchedRegistry('crates');
        setSearchInput(manifest.data.name);
        setLastSearchedInput(manifest.data.name);
        setLastSearchedVersion(manifest.data.version);

        const {resolveRustDependencyTreeFromManifest} = await import('./graph/rust-resolver');
        const tree = await resolveRustDependencyTreeFromManifest(manifest.data, { showPeerDeps }, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setSelectedNode(null);
      } else if (manifest.type === 'nuget') {
        setLastSearchedRegistry('nuget');
        setSearchInput(manifest.data.name);
        setLastSearchedInput(manifest.data.name);
        setLastSearchedVersion(manifest.data.version);

        const {resolveCSharpDependencyTreeFromManifest} = await import('./graph/csharp-resolver');
        const tree = await resolveCSharpDependencyTreeFromManifest(manifest.data, onProgress);
        if (tree.errors.length > 0) {
          console.warn('Dependency resolution had errors:', tree.errors);
        }
        setLoadingLabel('Computing layout…');
        const layout = await layoutGraph(tree);
        setGraphData(layout);
        setSelectedNode(null);
      }

      setFitViewSignal(s => s + 1);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Aborted') {
        console.log('Manifest fetch aborted');
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to fetch or parse manifest.';
      setErrorLine(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyView = async () => {
    if (!lastSearchedInput) return;
    const viewport = viewportContext?.getViewport();
    const url = buildURL(
      lastSearchedRegistry,
      lastSearchedInput,
      warningToggles,
      viewport ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom } : undefined,
      showPeerDeps,
      lastSearchedVersion,
      manifestUrl || undefined,
      undefined,
      micropackageThreshold
    );
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
        setComparisonLeftData({
          title: '',
          nodes: [],
          edges: [],
          isLoading: false,
          progress: { resolved: 0, total: 0 },
          loadingLabel: '',
          error: null
        });
        setComparisonRightData({
          title: '',
          nodes: [],
          edges: [],
          isLoading: false,
          progress: { resolved: 0, total: 0 },
          loadingLabel: '',
          error: null
        });
        setComparisonSelectedNode(null);
        // Clear the URL hash
        window.history.replaceState(null, '', '#');
      }

      const file = e.dataTransfer?.files?.[0];
      if (file && file.name === 'package.json') {
        try {
          const text = await file.text();
          const pkg = JSON.parse(text);
          if (!pkg.name) {
            setErrorLine('package.json missing name field.');
            setWarningLine(null);
            return;
          }
          if (!pkg.dependencies && !pkg.devDependencies) {
            setErrorLine('package.json has no dependencies to graph.');
            setWarningLine(null);
            return;
          }
          setLastSearchedRegistry('npm');
          const identifier = buildPackageIdentifier(pkg.name, pkg.version);
          setSearchInput(identifier);
          setLastSearchedInput(pkg.name);
          setLastSearchedVersion(pkg.version);
          setIsLoading(true);
          setErrorLine(null);
          setWarningLine(null);
          const onProgress = makeProgressCallback(`Resolving ${identifier}`);
          try {
            // For package.json drops, still use the old resolver for now
            // TODO: Update to use streaming resolver for local manifests too
            const { resolveDependencyTreeFromManifest } = await import('./graph/resolver');
            const tree = await resolveDependencyTreeFromManifest(pkg, { showPeerDeps }, onProgress);
            if (tree.errors.length > 0) {
              console.warn('Dependency resolution had errors:', tree.errors);
            }
            if (tree.cycles.length > 0) {
              setWarningLine(`Detected ${tree.cycles.length} dependency cycle${tree.cycles.length === 1 ? '' : 's'}.`);
            }
            setLoadingLabel('Enriching with deps.dev metadata…');
            await enrichGraphWithDepsDevData(tree);
            setLoadingLabel('Computing layout…');
            const layout = await layoutGraph(tree);
            setGraphData(layout);
            setSelectedNode(null);
            setFitViewSignal(s => s + 1);
            // Clear URL so refresh doesn't reload
            window.history.replaceState(null, '', '#');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to generate graph.';
            setErrorLine(message);
          } finally {
            setIsLoading(false);
          }
        } catch {
          setErrorLine('Failed to parse package.json.');
          setWarningLine(null);
        }
      } else if (file && (file.name === 'requirements.txt' || file.name.endsWith('.txt'))) {
        try {
          const text = await file.text();
          const deps = parseRequirementsTxt(text);
          if (deps.length === 0) {
            setErrorLine('requirements.txt has no dependencies to graph.');
            setWarningLine(null);
            return;
          }

          // Convert to manifest format
          const manifest = {
            name: file.name.replace('.txt', ''),
            version: 'local',
            description: `Python requirements from ${file.name}`,
            dependencies: Object.fromEntries(deps.filter(d => d.source === 'pypi').map(d => [d.name, d.specifier || '*']))
          };

          setLastSearchedRegistry('pypi');
          setSearchInput(manifest.name);
          setLastSearchedInput(manifest.name);
          setLastSearchedVersion(undefined);
          setIsLoading(true);
          setErrorLine(null);
          setWarningLine(null);

          const onProgress = makeProgressCallback(`Resolving Python deps`);
          try {
            const tree = await resolvePythonDependencyTreeFromManifest(manifest, onProgress);
            if (tree.errors.length > 0) {
              console.warn('Dependency resolution had errors:', tree.errors);
            }
            setLoadingLabel('Computing layout…');
            const layout = await layoutGraph(tree);
            setGraphData(layout);
            setSelectedNode(null);
            setFitViewSignal(s => s + 1);
            // Clear URL so refresh doesn't reload
            window.history.replaceState(null, '', '#');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to generate graph.';
            setErrorLine(message);
          } finally {
            setIsLoading(false);
          }
        } catch {
          setErrorLine('Failed to parse requirements.txt.');
          setWarningLine(null);
        }
      } else if (file && file.name === 'go.mod') {
        try {
          const text = await file.text();
          const deps = parseGoMod(text);
          const directDeps = deps.filter(d => !d.indirect);

          if (directDeps.length === 0) {
            setErrorLine('go.mod has no direct dependencies to graph.');
            setWarningLine(null);
            return;
          }

          // Extract module name from go.mod
          const moduleMatch = text.match(/^module\s+(\S+)/m);
          const moduleName = moduleMatch ? moduleMatch[1] : file.name.replace('.mod', '');

          // Convert to manifest format
          const manifest = {
            name: moduleName,
            version: 'local',
            description: `Go module from ${file.name}`,
            dependencies: Object.fromEntries(directDeps.map(d => [d.path, d.version]))
          };

          setLastSearchedRegistry('go');
          setSearchInput(manifest.name);
          setLastSearchedInput(manifest.name);
          setLastSearchedVersion(undefined);
          setIsLoading(true);
          setErrorLine(null);
          setWarningLine(null);

          const onProgress = makeProgressCallback(`Resolving Go deps`);
          try {
            const { resolveGoDependencyTreeFromManifest } = await import('./graph/go-resolver');
            const tree = await resolveGoDependencyTreeFromManifest(manifest, { showPeerDeps }, onProgress);
            if (tree.errors.length > 0) {
              console.warn('Dependency resolution had errors:', tree.errors);
            }
            setLoadingLabel('Computing layout…');
            const layout = await layoutGraph(tree);
            setGraphData(layout);
            setSelectedNode(null);
            setFitViewSignal(s => s + 1);
            // Clear URL so refresh doesn't reload
            window.history.replaceState(null, '', '#');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to generate graph.';
            setErrorLine(message);
          } finally {
            setIsLoading(false);
          }
        } catch {
          setErrorLine('Failed to parse go.mod.');
          setWarningLine(null);
        }
      } else if (file) {
        setErrorLine('Please drop a valid package.json, requirements.txt, Cargo.toml, or go.mod file.');
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

  const highlightedGraphData = useMemo(() => {
    // Compute search matches
    const searchLower = graphSearchQuery.trim().toLowerCase();
    const searchMatches = new Set<string>();
    if (searchLower) {
      for (const node of graphData.nodes) {
        if (node.data.pkgName.toLowerCase().includes(searchLower)) {
          searchMatches.add(node.id);
        }
      }
    }

    // Add warningToggles and searchMatch to all nodes first
    const nodesWithWarnings = graphData.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        warningToggles,
        micropackageThreshold,
        searchMatch: searchMatches.has(node.id) }
    }));

    if (!selectedNode) {
      return {
        ...graphData,
        nodes: nodesWithWarnings };
    }

    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();

    for (const edge of graphData.edges) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      outgoing.get(edge.source)!.push(edge.target);
      incoming.get(edge.target)!.push(edge.source);
    }

    const downstreamNodes = new Set<string>();
    const upstreamNodes = new Set<string>();
    const downstreamEdges = new Set<string>();
    const upstreamEdges = new Set<string>();

    const walk = (
      startId: string,
      neighbors: Map<string, string[]>,
      targetNodes: Set<string>,
      targetEdges: Set<string>
    ) => {
      const queue = [startId];
      const visited = new Set<string>([startId]);

      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of neighbors.get(current) || []) {
          targetEdges.add(`${current}->${next}`);
          if (visited.has(next)) continue;
          visited.add(next);
          targetNodes.add(next);
          queue.push(next);
        }
      }
    };

    walk(selectedNode, outgoing, downstreamNodes, downstreamEdges);
    walk(selectedNode, incoming, upstreamNodes, upstreamEdges);

    const highlightedNodes = nodesWithWarnings.map((node) => {
      let relationship: 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed' = 'dimmed';
      if (node.id === selectedNode) {
        relationship = 'selected';
      } else if (upstreamNodes.has(node.id) && downstreamNodes.has(node.id)) {
        relationship = 'both';
      } else if (upstreamNodes.has(node.id)) {
        relationship = 'upstream';
      } else if (downstreamNodes.has(node.id)) {
        let isDedicated = true;
        // Check if there are any paths to this purely downstream node from the root that DO NOT pass through selectedNode
        // We can do this explicitly by running a quick BFS/DFS from the roots IGNORING the selected node
        const reachableFromRoot = new Set<string>();
        const queue: string[] = [];
        for (const [id, n] of nodesWithWarnings.map(n => [n.id, n] as const)) {
          if (n.data.isRoot && n.id !== selectedNode) {
            queue.push(id);
            reachableFromRoot.add(id);
          }
        }

        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const next of outgoing.get(current) || []) {
            if (next === selectedNode) continue; // blocked by selected node
            if (!reachableFromRoot.has(next)) {
              reachableFromRoot.add(next);
              queue.push(next);
            }
          }
        }

        isDedicated = !reachableFromRoot.has(node.id);
        relationship = isDedicated ? 'dedicated' : 'downstream';
      }

      const isDimmed = relationship === 'dimmed';

      return {
        ...node,
        data: {
          ...node.data,
          relationship },
        style: {
          ...(node.style || {}),
          opacity: isDimmed ? 0.4 : 1,
          transition: 'opacity 180ms ease' }
      };
    });

    const highlightedEdges = graphData.edges.map((edge) => {
      const forwardKey = `${edge.source}->${edge.target}`;
      const reverseKey = `${edge.target}->${edge.source}`;
      const isDownstream = downstreamEdges.has(forwardKey);
      const isUpstream = upstreamEdges.has(reverseKey);

      let relationship: 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed' = 'dimmed';
      if (isUpstream && isDownstream) {
        relationship = 'both';
      } else if (isUpstream) {
        relationship = 'upstream';
      } else if (isDownstream) {
        // Find if target node is dedicated
        const targetNode = highlightedNodes.find(n => n.id === edge.target);
        if (targetNode?.data.relationship === 'dedicated') {
          relationship = 'dedicated';
        } else {
          relationship = 'downstream';
        }
      }

      let stroke = edge.type === 'peer' || edge.type === 'extra' ? '#c084fc' : 'var(--text-muted)';
      let opacity = edge.type === 'peer' || edge.type === 'extra' ? 0.6 : 0.14;
      let strokeWidth = edge.type === 'peer' || edge.type === 'extra' ? 3 : 2;
      let strokeDasharray = edge.type === 'peer' || edge.type === 'extra' ? '6 6' : undefined;

      if (relationship === 'upstream') {
        stroke = 'var(--accent-emerald)';
        opacity = 0.95;
        strokeWidth = 3;
      } else if (relationship === 'downstream') {
        stroke = 'var(--accent-blue)';
        opacity = 0.95;
        strokeWidth = 3;
      } else if (relationship === 'dedicated') {
        stroke = 'var(--accent-blue)';
        opacity = 1;
        strokeWidth = 2;
        // Ensure dedicated peers/extras keep dash style
        strokeDasharray = edge.type === 'peer' || edge.type === 'extra' ? '6 6' : undefined;
      } else if (relationship === 'both') {
        stroke = 'var(--accent-amber)';
        opacity = 1;
        strokeWidth = 3;
      }

      return {
        ...edge,
        style: {
          ...(edge.style || {}),
          stroke,
          opacity,
          strokeWidth,
          strokeDasharray,
          transition: 'opacity 180ms ease, stroke 180ms ease' }
      };
    });

    return {
      nodes: highlightedNodes,
      edges: highlightedEdges };
  }, [graphData, selectedNode, warningToggles, graphSearchQuery, micropackageThreshold]);

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
                display: 'none',
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
              const { resolveDependencyTree } = await import('./graph/resolver');
              return await resolveDependencyTree(lastSearchedInput, version, { showPeerDeps });
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
                  onNodeClick={handleComparisonNodeClick}
                  fitViewSignalLeft={fitViewSignalLeft}
                  fitViewSignalRight={fitViewSignalRight}
                />
                <button
                  onClick={() => {
                    setComparisonLeftData({
                      title: '',
                      nodes: [],
                      edges: [],
                      isLoading: false,
                      progress: { resolved: 0, total: 0 },
                      loadingLabel: '',
                      error: null
                    });
                    setComparisonRightData({
                      title: '',
                      nodes: [],
                      edges: [],
                      isLoading: false,
                      progress: { resolved: 0, total: 0 },
                      loadingLabel: '',
                      error: null
                    });
                    setComparisonLeftSpec(null);
                    setComparisonRightSpec(null);
                    setComparisonSelectedNode(null);
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
