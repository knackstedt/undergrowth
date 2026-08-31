# Undergrowth

### See Your Dependencies. Panic Responsibly.

- Visualizes npm, PyPI, Rust, Go, and .NET
- Customizable filters for package weakness grading
- Lets you share exact, terrifying views via permalinkable URLs

## Features

- **Multi-Ecosystem Support**: Visualize dependencies from npm (Node.js), PyPI (Python), Crates.io (Rust), Go modules, and NuGet (.NET/C#) in a single interface.

- **Manifest Parsing**: Paste a link to a `package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, or `.csproj` file to graph an entire project's dependency tree.

- **Quality Filters**: Highlight packages matching quality criteria:
  - Excessive dependency count
  - Single maintainer
  - Prerelease versions
  - Missing TypeScript types
  - ESM/CJS module format

- **Smart Layout**: Smart graph layout with optimized spacing and minimal edge crossings for clear visualization.

- **Interactive Exploration**: 
  - Click any node to see package metadata, download stats, maintainers, and rendered README
  - Hover edges to trace dependency paths
  - Toggle peer dependencies on/off
  - Focus mode isolates upstream/downstream dependencies of selected packages

- **Shareable State**: Every filter, toggle, and viewport position is encoded in the URL—share exact views with teammates.

- **Git Repository Support**: Enter a GitHub or GitLab URL to analyze dependencies of source repositories.

- **Comparison Mode**: Compare two versions of a dependency tree side-by-side. Visual diff highlighting shows packages that are new (green), removed (red), updated (amber), or unchanged (dimmed). Supports comparing package versions or dragging-and-drop manifest files (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `.csproj`).

## Usage

1. Select your ecosystem (npm, PyPI, Crates, Go, or NuGet) from the dropdown.
2. Enter a package name (e.g., `express`, `numpy`, `serde`) or paste a manifest URL.
3. Click **Graph It** to build the dependency tree.
4. Use the filter panel to highlight packages matching risk criteria.
5. Click any node to inspect details, or copy the URL to share your current view.

### Comparison Mode

Compare two versions of a package to see how its dependency tree changes:

1. Click the **Compare** button in the control bar to enter comparison mode.
2. Enter a package name and version for the left side (Previous Version), or drag-and-drop a manifest file.
3. Enter a package name and version for the right side (New Version), or drag-and-drop a manifest file.
4. Click **Compare Versions** to see the diff.
5. Drag the center divider to resize the panels.

Packages are color-coded by their change status:
- **Green**: Newly added dependencies
- **Red**: Removed dependencies
- **Amber**: Dependencies with version updates
- **Dimmed**: Unchanged dependencies

## Development

### Installation

```bash
bun install
```

### Running Locally

```bash
bun run dev
```

Navigate to `http://localhost:5173/` in your browser.