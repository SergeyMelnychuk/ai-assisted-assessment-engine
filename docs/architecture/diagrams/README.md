# Architecture diagrams

Ten files live here — one Structurizr workspace covering the full C4
model, nine Mermaid views focused on specific angles. All of them are
**text-based and commit-friendly**: edit in any editor, review in
`git diff`, render on demand.

| File | View | Use it when |
|---|---|---|
| [`workspace.dsl`](./workspace.dsl) | Structurizr C4 workspace (system-context, container, components for web + worker) | You want the canonical multi-level model. Re-use elements across views. |
| [`system-context.mmd`](./system-context.mmd) | Mermaid C4-context | You want a one-slide overview for a non-technical audience. |
| [`container-topology.mmd`](./container-topology.mmd) | Mermaid C4-container | You want to see protocols + ports between runtime containers. |
| [`deployment.mmd`](./deployment.mmd) | Mermaid flowchart (LR) | You're onboarding to the dev environment or planning prod deployment. |
| [`data-flow.mmd`](./data-flow.mmd) | Mermaid flowchart | You're tracing how a file or an answer becomes a finding / a deliverable. |
| [`sequence-analysis.mmd`](./sequence-analysis.mmd) | Mermaid sequence | You're debugging or documenting the `run-analysis` worker job. |
| [`archive-ingestion.mmd`](./archive-ingestion.mmd) | Mermaid flowchart | You're tracing how a `.zip` / `.tar.gz` upload fans out into child Documents (ADR-0008 safety gates). |
| [`repo-link-flow.mmd`](./repo-link-flow.mmd) | Mermaid flowchart | You're tracing the GitHub-PAT → tarball → Evidence path (ADR-0009 / 0010, ADR-0022). |
| [`retrieval-flow.mmd`](./retrieval-flow.mmd) | Mermaid flowchart | You're inspecting how a query becomes top-K chunks (cosine + hybrid RRF, ADR-0006 / 0007 / 0027). |
| [`evidence-trail.mmd`](./evidence-trail.mmd) | Mermaid flowchart | You're following the evidence-traceability path from retrieval → finding → Why-this-finding panel → context popup (ADR-0011 / 0028). |

---

## Rendering the Mermaid files

### In a browser
1. Open <https://mermaid.live/>.
2. Paste the file contents into the left pane.
3. Right-hand preview updates live; export PNG / SVG from the toolbar.

### On GitHub / GitLab
`.mmd` files don't auto-render inline on most forges — embed them in
markdown fenced blocks where you want them rendered:

<pre><code>```mermaid
&lt;paste file contents&gt;
```
</code></pre>

GitHub, GitLab, VS Code's built-in preview, and mdBook all render
fenced `mermaid` blocks.

### From the CLI
`@mermaid-js/mermaid-cli` is already a workspace dep:

```bash
pnpm --filter @copilot/web exec mmdc \
  -i docs/architecture/diagrams/container-topology.mmd \
  -o container-topology.svg
```

Note: `mmdc` wraps puppeteer + Chromium. First run on a fresh machine
will download a Chromium build.

---

## Rendering the Structurizr DSL

Three common paths, in order of convenience:

### 1. Structurizr Lite (recommended for local iteration)

```bash
# one-time: pull the image
docker pull structurizr/lite

# from the repo root — serve workspace.dsl on localhost:8090
docker run -it --rm \
  -p 8090:8080 \
  -v "$(pwd)/docs/architecture/diagrams:/usr/local/structurizr" \
  structurizr/lite
```

Open <http://localhost:8090>. The tool watches the file, so edits
reload the preview.

### 2. Structurizr CLI (for exports)

```bash
docker run --rm \
  -v "$(pwd)/docs/architecture/diagrams:/usr/local/structurizr" \
  structurizr/cli export -workspace workspace.dsl -format mermaid
```

`-format mermaid` drops `.mmd` files for every view back into the
same folder. `-format plantuml`, `-format dot`, `-format json`, and
`-format png` (with `-output /path`) also work.

### 3. Paste into structurizr.com

`https://structurizr.com/dsl` has a live editor that accepts the
workspace file and renders every view inline. Good for sharing a URL
with a reviewer who doesn't want to run Docker.

---

## When a diagram and the code disagree

The code wins. These diagrams are hand-maintained; if you've just
shipped a change that moves a boundary, update the relevant `.mmd` or
`.dsl` in the same PR. Reviewers should treat an out-of-sync diagram
as a review blocker.

The shortest path to keeping them honest:

1. Rename / introduce / delete the container / component in the code.
2. Open the corresponding view file in a mermaid.live preview.
3. Edit until it matches, commit in the same PR as the code change.

For the Structurizr workspace, a single edit propagates to every view
that uses the changed element — that's the point of using it over
flat Mermaid for the core model.

---

## Why both Structurizr and Mermaid?

- **Structurizr** gives us a proper model: elements defined once, used
  across system-context / container / component views. It's our
  canonical source for the C4 shape of the system.
- **Mermaid** is zero-tooling: renders in GitHub PRs, in this repo's
  README, in reviewer IDEs without any extra setup. We use it for the
  views that don't need the Structurizr model machinery (data flow,
  sequence, deployment).

If both disagree, **Structurizr is the canonical C4 source**; Mermaid
views might lag in minor details but should always agree on
system-context and container-level relationships.
