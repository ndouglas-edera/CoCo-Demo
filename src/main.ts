import { BaseImage, Cluster, type ProcessContext } from "@ngrok/webernetes";
import "./style.css";

class WebServerImage extends BaseImage {
  static readonly imageName = "web-server";
  static readonly imageVersion = "1.0";
  readonly defaultCommand = ["server"];

  override async exec(
    ctx: ProcessContext,
    _argv: readonly string[],
  ): Promise<number> {
    ctx.listenHttp(8080, async () => ({
      statusCode: 200,
      body: "Hello from browser-hosted Kubernetes!\n",
    }));

    return await ctx.waitUntilKilled();
  }
}

interface DemoStep {
  id: string;
  title: string;
  description: string;
  command: string;
  optional?: boolean;
}

interface SimPod {
  name: string;
  namespace: string;
  status: "Pending" | "Running" | "Succeeded";
  image: string;
  runtimeClassName?: string;
  annotations?: Record<string, string>;
}

interface SimRuntimeClass {
  name: string;
  handler: string;
  description: string;
  production?: boolean;
}

const NGINX_YAML_CONTENT = `apiVersion: v1
kind: Pod
metadata:
  labels:
    run: nginx
  name: nginx
  annotations:
    io.containerd.cri.runtime-handler: kata-qemu-coco-dev
spec:
  containers:
  - name: nginx
    image: nginx:1.29.4
  dnsPolicy: ClusterFirst
  runtimeClassName: kata-qemu-coco-dev
`;

const NGINX_PRODUCTION_YAML_CONTENT = `apiVersion: v1
kind: Pod
metadata:
  name: nginx-production
spec:
  runtimeClassName: kata-qemu-tdx
  containers:
  - image: bitnami/nginx:latest
    name: nginx
`;

const NGINX_SNP_YAML_CONTENT = `apiVersion: v1
kind: Pod
metadata:
  name: nginx-production-snp
spec:
  runtimeClassName: kata-qemu-snp
  containers:
  - image: bitnami/nginx:latest
    name: nginx
`;

const AGENT_POLICY_CONTENT = `package agent_policy
import rego.v1

default CreateContainerRequest := false
default ExecProcessRequest := false

# Only allow a specific, digest-pinned image.
CreateContainerRequest if {
  input.storages[0].source == "docker.io/library/nginx@sha256:abc123..."
}
`;

const INITDATA_CONTENT = `version = "0.1.0"
algorithm = "sha384"

[data]
"policy.rego" = '''
package agent_policy
import rego.v1

default CreateContainerRequest := false
default ExecProcessRequest := false

CreateContainerRequest if {
  input.storages[0].source == "docker.io/library/nginx@sha256:abc123..."
}
'''
`;

const KBS_RESOURCE_POLICY_COMMAND =
  "kbs-client --url <kbs-url> config --admin-token-file <admin-token-file> set-resource-policy --policy-file <path-to-policy-file>";

const ATTESTATION_POLICY_COMMAND =
  "kbs-client --url <kbs-url> config --admin-token-file <admin-token-file> set-attestation-policy --policy-file <path-to-policy-file>";

const COCO_DEMO_STEPS: DemoStep[] = [
  {
    id: "install",
    title: "Install Confidential Containers",
    description:
      "Install the Confidential Containers runtime from the official Helm chart. The chart creates the <code class='guide-code'>coco-system</code> namespace.",
    command:
      "helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers --namespace coco-system --create-namespace",
  },
  {
    id: "wait",
    title: "Wait for CoCo to become ready",
    description:
      "Watch the CoCo system pods until each pod reports <code class='guide-code'>Running</code>.",
    command: "kubectl get pods -n coco-system --watch",
  },
  {
    id: "runtimeclasses",
    title: "Verify the RuntimeClasses",
    description:
      "List the RuntimeClasses installed by CoCo. The development runtime is intended for testing; production runtimes correspond to real TEE hardware.",
    command: "kubectl get runtimeclass",
  },
  {
    id: "workload-file",
    title: "Inspect the sample workload",
    description:
      "The upstream getting-started workload uses nginx with <code class='guide-code'>kata-qemu-coco-dev</code>. The RuntimeClass and runtime-handler annotation are the key CoCo settings in this example.",
    command: "cat nginx.yaml",
  },
  {
    id: "workload-apply",
    title: "Create the confidential workload",
    description:
      "Apply the sample nginx Pod. This uses the development CoCo runtime, which is useful for learning the workflow but does not provide hardware confidentiality guarantees.",
    command: "kubectl apply -f nginx.yaml",
  },
  {
    id: "workload-status",
    title: "Verify the workload",
    description:
      "Confirm that the nginx Pod reaches <code class='guide-code'>Running</code>, just as in the official Simple Workload guide.",
    command: "kubectl get pods",
  },
  {
    id: "runtime-inspect",
    title: "Inspect the workload RuntimeClass",
    description:
      "Check which RuntimeClass the workload requested. This is the Kubernetes-level switch that selects the CoCo runtime.",
    command:
      "kubectl get pod nginx -o jsonpath='{.spec.runtimeClassName}'",
  },
  {
    id: "production-tdx",
    title: "Select a production TDX runtime",
    description:
      "For Intel TDX hardware, the official production example uses <code class='guide-code'>kata-qemu-tdx</code>. The runtime must match the hardware available to the cluster.",
    command: "cat nginx-production.yaml",
  },
  {
    id: "production-snp",
    title: "Compare the SNP runtime",
    description:
      "AMD SEV-SNP uses <code class='guide-code'>kata-qemu-snp</code>. A mismatched runtime class and hardware combination will prevent the Pod from being created.",
    command: "cat nginx-production-snp.yaml",
  },
  {
    id: "agent-policy",
    title: "Define a Kata Agent Policy",
    description:
      "Kata Agent Policy is enforced inside the TEE by Kata Agent. A restrictive policy can deny operations such as container creation or exec and allow only approved image digests.",
    command: "cat agent-policy.rego",
  },
  {
    id: "initdata",
    title: "Embed policy in Init-Data",
    description:
      "CoCo embeds the Kata Agent Policy in Init-Data. Init-Data is measured into the TEE evidence, allowing downstream attestation policy to verify which policy was applied.",
    command: "cat initdata.toml",
  },
  {
    id: "kbs-resource-policy",
    title: "Configure KBS Resource Policy",
    description:
      "KBS Resource Policies control which secrets are released to which workloads. They can use attestation claims, including the measured Init-Data, to make release decisions.",
    command: KBS_RESOURCE_POLICY_COMMAND,
  },
  {
    id: "attestation-policy",
    title: "Configure Attestation Service Policy",
    description:
      "Attestation Service Policies define how hardware evidence is evaluated and which reference values and trust conditions are acceptable.",
    command: ATTESTATION_POLICY_COMMAND,
  },
  {
    id: "production-checklist",
    title: "Review the production checklist",
    description:
      "Before production deployment, verify the hardware-specific RuntimeClass, an appropriate Kata Agent Policy, KBS Resource Policies, and attestation reference values.",
    command: "coco production-checklist",
  },
];

const runtimeClasses: SimRuntimeClass[] = [
  {
    name: "kata-qemu-coco-dev",
    handler: "kata-qemu-coco-dev",
    description: "Development/testing runtime; no TEE security guarantees",
  },
  {
    name: "kata-qemu-coco-dev-runtime-rs",
    handler: "kata-qemu-coco-dev-runtime-rs",
    description: "Development/testing runtime using the Rust-based runtime",
  },
  {
    name: "kata-qemu-tdx",
    handler: "qemu-tdx",
    description: "Intel TDX",
    production: true,
  },
  {
    name: "kata-qemu-snp",
    handler: "qemu-snp",
    description: "AMD SEV-SNP",
    production: true,
  },
  {
    name: "kata-qemu-sev",
    handler: "qemu-sev",
    description: "AMD SEV",
    production: true,
  },
  {
    name: "kata-qemu-nvidia-gpu-tdx",
    handler: "qemu-nvidia-gpu-tdx",
    description: "Intel TDX with NVIDIA GPU support",
    production: true,
  },
  {
    name: "kata-qemu-nvidia-gpu-snp",
    handler: "qemu-nvidia-gpu-snp",
    description: "AMD SNP with NVIDIA GPU support",
    production: true,
  },
  {
    name: "kata-qemu-se",
    handler: "qemu-se",
    description: "IBM Secure Execution",
    production: true,
  },
  {
    name: "kata-remote",
    handler: "kata-remote",
    description: "Cloud API Adaptor / peer-pods",
    production: true,
  },
];

async function initTerminalDemo() {
  const app = document.querySelector<HTMLDivElement>("#app")!;

  app.innerHTML = `
    <div class="demo-shell">
      <header class="top-header">
        <a href="https://confidentialcontainers.org/" class="logo-link">
          CONFIDENTIAL CONTAINERS
        </a>
        <a
          href="https://confidentialcontainers.org/docs/getting-started/"
          target="_blank"
          rel="noopener noreferrer"
          class="edera-free-cta"
          style="justify-self:end;align-self:center;display:inline-flex;align-items:center;padding:12px 22px;border-radius:999px;background:var(--edera-lime);color:var(--edera-ink);font-weight:800;text-decoration:none;white-space:nowrap;"
        >Official getting started →</a>
      </header>

      <section class="brand-hero" aria-labelledby="hero-title">
        <div class="hero-eyebrow">CONFIDENTIAL CONTAINERS × WEBERNETES</div>
        <h2 id="hero-title">RUN<br />CONFIDENTIAL WORKLOADS</h2>
        <p>
          Follow the official Confidential Containers getting-started path:
          install CoCo, run a simple workload, then move toward production
          hardware and policy-based protection.
        </p>
        <button id="hero-run-btn" class="hero-cta" type="button">Jump to Guide</button>
      </section>

      <div class="demo-kicker">
        Webernetes × Confidential Computing — interactive getting-started demo
      </div>

      <div class="dashboard-grid">
        <div class="panel" id="pods-panel">
          <div class="panel-header">
            <span class="drag-handle">⋮⋮</span>
            <h3>📦 Active Pods</h3>
            <span id="pod-count" class="panel-count">0 Pods</span>
            <button class="hide-btn" id="hide-pods-btn">Hide</button>
          </div>
          <div class="resource-body" id="pods-body">
            <div id="pod-grid" class="resource-list"></div>
          </div>
        </div>

        <div class="panel" id="nodes-panel">
          <div class="panel-header">
            <span class="drag-handle">⋮⋮</span>
            <h3>🖥️ Active Nodes</h3>
            <span id="node-count" class="panel-count">3 Nodes</span>
            <button class="hide-btn" id="hide-nodes-btn">Hide</button>
          </div>
          <div class="resource-body" id="nodes-body">
            <div id="node-grid" class="resource-list"></div>
          </div>
        </div>
      </div>

      <div class="main-layout">
        <div class="terminal-panel">
          <div id="output" class="terminal-output" aria-live="polite"></div>
          <div class="terminal-input-row">
            <span id="terminal-prompt">ivy@webernetes:~$</span>
            <input
              id="cmd"
              type="text"
              placeholder="Type 'help' or use Up/Down arrow keys for command history..."
              disabled
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>

        <div class="panel events-panel" id="events-panel">
          <div class="panel-header">
            <span class="drag-handle">⋮⋮</span>
            <h3>⚡ Lifecycle Events</h3>
            <button class="hide-btn" id="clear-events-btn">Clear</button>
            <button class="hide-btn" id="hide-events-btn">Hide</button>
          </div>
          <div id="events-stream" class="events-stream"></div>
        </div>
      </div>

      <div class="guide-panel" id="guide-panel">
        <div class="guide-header">
          <span class="drag-handle">⋮⋮</span>
          <div>
            <div class="guide-title" id="guide-title">🧭 Confidential Containers Guide</div>
            <div class="guide-subtitle" id="guide-subtitle">
              Follow the official installation, workload, and production-security path
            </div>
          </div>
          <div id="guide-progress" class="guide-progress"></div>
          <button class="hide-btn" id="hide-guide-btn">Hide</button>
        </div>

        <div class="guide-body" id="guide-body">
          <div class="guide-current">
            <div class="guide-label">Suggested next command</div>
            <div id="guide-step-title" class="guide-step-title"></div>
            <div id="guide-description" class="guide-description"></div>
            <div class="suggested-command">
              <code id="suggested-command"></code>
              <button id="use-command-btn" class="use-command-btn">Use command</button>
            </div>
          </div>

          <div class="guide-side">
            <div class="guide-side-title">Demo flow</div>
            <div id="guide-step-list"></div>
          </div>
        </div>
      </div>

      <div class="edera-footer">
        <span>
          Built around the official
          <a href="https://confidentialcontainers.org/docs/getting-started/" target="_blank" rel="noopener noreferrer">
            Confidential Containers getting-started documentation
          </a>
        </span>
      </div>

      <div
        id="completion-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="completion-title"
        style="position:fixed;inset:0;z-index:1000;display:none;place-items:center;padding:24px;"
      >
        <div
          id="completion-modal-backdrop"
          aria-hidden="true"
          style="position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);"
        ></div>
        <div
          style="position:relative;width:min(560px,100%);padding:42px;border:1px solid rgba(184,255,60,.35);border-radius:20px;background:#081716;box-shadow:0 24px 80px rgba(0,0,0,.5);text-align:center;"
        >
          <button
            id="completion-close"
            type="button"
            aria-label="Close completion message"
            style="position:absolute;top:12px;right:16px;border:0;background:transparent;color:#a8cfca;font-size:28px;line-height:1;cursor:pointer;"
          >×</button>
          <div style="width:64px;height:64px;margin:0 auto 20px;display:grid;place-items:center;border-radius:50%;background:#b8ff3c;color:#081716;font-size:32px;font-weight:800;">✓</div>
          <div style="margin-bottom:10px;color:#00e5d4;font-size:12px;font-weight:800;letter-spacing:.16em;">GUIDE COMPLETE</div>
          <h2 id="completion-title" style="margin:0 0 14px;color:#f8fffd;font-size:30px;">You completed the CoCo getting-started path.</h2>
          <p style="margin:0 0 28px;color:#a8cfca;line-height:1.6;">
            You installed CoCo, deployed a development workload, selected production runtime classes,
            and reviewed the three policy layers used to secure production deployments.
          </p>
          <div class="completion-actions">
            <button id="restart-demo-btn" type="button" class="completion-restart-btn">Start a new session</button>
            <a
              href="https://confidentialcontainers.org/docs/getting-started/"
              target="_blank"
              rel="noopener noreferrer"
              class="completion-license-link"
            >Read the official docs →</a>
          </div>
        </div>
      </div>
    </div>
  `;

  const output = document.querySelector<HTMLDivElement>("#output")!;
  const input = document.querySelector<HTMLInputElement>("#cmd")!;
  const prompt = document.querySelector<HTMLSpanElement>("#terminal-prompt")!;
  const podGrid = document.querySelector<HTMLDivElement>("#pod-grid")!;
  const podCount = document.querySelector<HTMLSpanElement>("#pod-count")!;
  const nodeGrid = document.querySelector<HTMLDivElement>("#node-grid")!;
  const nodeCount = document.querySelector<HTMLSpanElement>("#node-count")!;
  const eventsStream = document.querySelector<HTMLDivElement>("#events-stream")!;
  const guideStepTitle = document.querySelector<HTMLDivElement>("#guide-step-title")!;
  const guideDescription = document.querySelector<HTMLDivElement>("#guide-description")!;
  const suggestedCommand = document.querySelector<HTMLElement>("#suggested-command")!;
  const guideStepList = document.querySelector<HTMLDivElement>("#guide-step-list")!;
  const guideProgress = document.querySelector<HTMLDivElement>("#guide-progress")!;
  const useCommandBtn = document.querySelector<HTMLButtonElement>("#use-command-btn")!;
  const guidePanel = document.querySelector<HTMLElement>("#guide-panel")!;

  const completionModal = document.querySelector<HTMLDivElement>("#completion-modal")!;
  const completionClose = document.querySelector<HTMLButtonElement>("#completion-close")!;
  const completionBackdrop = document.querySelector<HTMLDivElement>("#completion-modal-backdrop")!;
  const restartDemoBtn = document.querySelector<HTMLButtonElement>("#restart-demo-btn")!;

  let cluster: Cluster;
  let currentDirectory = "/";
  let selectedStepIndex: number | null = null;
  let completedSteps = new Set<string>();
  let completionShown = false;
  let helmInstalled = false;

  let pods: SimPod[] = [
    {
      name: "demo-pod",
      namespace: "default",
      status: "Running",
      image: "web-server:1.0",
    },
  ];

  const nodes = [
    { name: "node-1", status: "Ready", role: "worker", runtime: "containerd" },
    { name: "node-2", status: "Ready", role: "worker", runtime: "containerd" },
    { name: "node-3", status: "Ready", role: "worker", runtime: "containerd" },
  ];

  const events: Array<{
    type: "Normal" | "Warning" | "Info";
    reason: string;
    object: string;
    message: string;
  }> = [];

  const localFiles: Record<string, string> = {
    "/nginx.yaml": NGINX_YAML_CONTENT,
    "/nginx-production.yaml": NGINX_PRODUCTION_YAML_CONTENT,
    "/nginx-production-snp.yaml": NGINX_SNP_YAML_CONTENT,
    "/agent-policy.rego": AGENT_POLICY_CONTENT,
    "/initdata.toml": INITDATA_CONTENT,
  };

  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const printPre = (value: string) => {
    output.insertAdjacentHTML(
      "beforeend",
      `<div class="terminal-block"><pre>${value}</pre></div>`,
    );
    output.scrollTop = output.scrollHeight;
  };

  const printHtml = (value: string) => {
    output.insertAdjacentHTML(
      "beforeend",
      `<div class="terminal-block">${value}</div>`,
    );
    output.scrollTop = output.scrollHeight;
  };

  const addEvent = (
    type: "Normal" | "Warning" | "Info",
    reason: string,
    object: string,
    message: string,
  ) => {
    events.unshift({ type, reason, object, message });
    renderEvents();
  };

  const renderEvents = () => {
    if (events.length === 0) {
      eventsStream.innerHTML =
        `<div style="color:#a8cfca;padding:16px;">No lifecycle events yet.</div>`;
      return;
    }

    eventsStream.innerHTML = events
      .slice(0, 30)
      .map(
        (event) => `
          <div class="event-row">
            <div class="event-time">now</div>
            <div class="event-type ${event.type.toLowerCase()}">${escapeHtml(event.type)}</div>
            <div class="event-reason">${escapeHtml(event.reason)}</div>
            <div class="event-object">${escapeHtml(event.object)}</div>
            <div class="event-message">${escapeHtml(event.message)}</div>
          </div>
        `,
      )
      .join("");
  };

  const renderPods = () => {
    podCount.innerText = `${pods.length} Pod${pods.length === 1 ? "" : "s"}`;

    podGrid.innerHTML =
      pods.length === 0
        ? `<div style="color:#a8cfca;padding:16px;">No pods.</div>`
        : pods
            .map(
              (pod) => `
                <div class="resource-card">
                  <div class="resource-card-title">${escapeHtml(pod.name)}</div>
                  <div class="resource-card-meta">
                    <span>${escapeHtml(pod.namespace)}</span>
                    <span>${escapeHtml(pod.status)}</span>
                  </div>
                  <div class="resource-card-detail">
                    <strong>image:</strong> ${escapeHtml(pod.image)}
                  </div>
                  <div class="resource-card-detail">
                    <strong>runtimeClass:</strong> ${escapeHtml(pod.runtimeClassName || "—")}
                  </div>
                </div>
              `,
            )
            .join("");
  };

  const renderNodes = () => {
    nodeCount.innerText = `${nodes.length} Nodes`;

    nodeGrid.innerHTML = nodes
      .map(
        (node) => `
          <div class="resource-card">
            <div class="resource-card-title">${escapeHtml(node.name)}</div>
            <div class="resource-card-meta">
              <span>${escapeHtml(node.status)}</span>
              <span>${escapeHtml(node.role)}</span>
            </div>
            <div class="resource-card-detail">
              <strong>runtime:</strong> ${escapeHtml(node.runtime)}
            </div>
          </div>
        `,
      )
      .join("");
  };

  const updateDashboard = () => {
    renderPods();
    renderNodes();
  };

  const normalizePath = (path: string) => {
    if (!path || path === "~") return currentDirectory;
    const absolute = path.startsWith("/")
      ? path
      : `${currentDirectory}/${path}`;
    const parts = absolute.split("/");
    const normalized: string[] = [];

    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        normalized.pop();
        continue;
      }
      normalized.push(part);
    }

    return normalized.length ? `/${normalized.join("/")}` : "/";
  };

  const resolveFile = (path: string) => localFiles[normalizePath(path)];

  const virtualDisplayPath = () =>
    currentDirectory === "/" ? "~" : `~${currentDirectory}`;

  const isComplete = () =>
    COCO_DEMO_STEPS.every((step) => completedSteps.has(step.id));

  const nextStepIndex = () => {
    const next = COCO_DEMO_STEPS.findIndex(
      (step) => !completedSteps.has(step.id),
    );
    return next === -1 ? COCO_DEMO_STEPS.length - 1 : next;
  };

  const selectedIndex = () =>
    selectedStepIndex !== null &&
    selectedStepIndex >= 0 &&
    selectedStepIndex < COCO_DEMO_STEPS.length
      ? selectedStepIndex
      : nextStepIndex();

  const renderGuide = () => {
    const index = selectedIndex();
    const step = COCO_DEMO_STEPS[index];

    guideProgress.innerHTML = COCO_DEMO_STEPS.map(
      (item, itemIndex) =>
        `<span class="progress-dot ${
          completedSteps.has(item.id)
            ? "done"
            : itemIndex === index
              ? "current"
              : ""
        }" title="${escapeHtml(item.title)}"></span>`,
    ).join("");

    guideStepTitle.innerHTML =
      `${escapeHtml(step.title)}${
        step.optional
          ? `<span class="optional-badge">OPTIONAL</span>`
          : ""
      }`;

    guideDescription.innerHTML = step.description;
    suggestedCommand.innerText = step.command;

    guideStepList.innerHTML = COCO_DEMO_STEPS.map(
      (item, itemIndex) => `
        <button
          type="button"
          class="guide-step-mini ${
            completedSteps.has(item.id)
              ? "done"
              : itemIndex === index
                ? "current"
                : ""
          } ${itemIndex === index ? "selected" : ""}"
          data-step-index="${itemIndex}"
          title="${escapeHtml(item.title)}"
        >
          <span class="mini-number">${itemIndex + 1}.</span>
          <span>
            ${escapeHtml(item.title)}
            ${
              item.optional
                ? `<span class="optional-badge">optional</span>`
                : ""
            }
          </span>
        </button>
      `,
    ).join("");
  };

  const showCompletionModal = () => {
    if (completionShown) return;
    completionShown = true;
    completionModal.hidden = false;
    completionModal.style.display = "grid";
  };

  const closeCompletionModal = () => {
    completionModal.hidden = true;
    completionModal.style.display = "none";
  };

  const markStepComplete = (id: string) => {
    const wasComplete = isComplete();
    completedSteps.add(id);

    if (
      selectedStepIndex === null ||
      COCO_DEMO_STEPS[selectedStepIndex]?.id === id
    ) {
      selectedStepIndex = nextStepIndex();
    }

    renderGuide();

    if (!wasComplete && isComplete()) {
      requestAnimationFrame(showCompletionModal);
    }
  };

  const selectStep = (index: number) => {
    if (index < 0 || index >= COCO_DEMO_STEPS.length) return;
    selectedStepIndex = index;
    renderGuide();
  };

  const renderRuntimeClasses = () => {
    printPre(
      `<span style="color:#00e5d4;">NAME${" ".repeat(34)}HANDLER${" ".repeat(20)}DESCRIPTION</span>\n` +
        `<span style="color:#08736d;">${"─".repeat(105)}</span>\n` +
        runtimeClasses
          .map(
            (runtimeClass) =>
              `<span style="color:${
                runtimeClass.production ? "#dff7f0" : "#ffd166"
              };">${escapeHtml(
                runtimeClass.name.padEnd(38) +
                  runtimeClass.handler.padEnd(28) +
                  runtimeClass.description,
              )}</span>`,
          )
          .join("\n"),
    );
  };

  const formatHelp = () => `
    <div class="cli-help">
      <div class="cli-help-header">
        <div class="cli-help-title">☁️ Confidential Containers CLI</div>
        <div class="cli-help-version">Simulated browser environment</div>
      </div>

      <div class="cli-help-description">
        This terminal mirrors the commands used in the official Confidential Containers
        getting-started documentation. The browser demo simulates CoCo resources; it does
        not provide real TEE hardware.
      </div>

      <div class="cli-help-section">
        <div class="cli-help-section-title">Installation</div>
        <div class="cli-help-command">
          <code>helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers --namespace coco-system --create-namespace</code>
          <span>Install the CoCo Helm chart.</span>
        </div>
        <div class="cli-help-command">
          <code>kubectl get pods -n coco-system --watch</code>
          <span>Watch the CoCo system pods until they are Running.</span>
        </div>
      </div>

      <div class="cli-help-section">
        <div class="cli-help-section-title">Simple workload</div>
        <div class="cli-help-command">
          <code>cat nginx.yaml</code>
          <span>Show the official sample nginx workload.</span>
        </div>
        <div class="cli-help-command">
          <code>kubectl apply -f nginx.yaml</code>
          <span>Create the sample CoCo workload.</span>
        </div>
        <div class="cli-help-command">
          <code>kubectl get pods</code>
          <span>Verify the workload is Running.</span>
        </div>
      </div>

      <div class="cli-help-section">
        <div class="cli-help-section-title">Production security</div>
        <div class="cli-help-command">
          <code>cat nginx-production.yaml</code>
          <span>Inspect an Intel TDX workload using kata-qemu-tdx.</span>
        </div>
        <div class="cli-help-command">
          <code>cat agent-policy.rego</code>
          <span>Inspect a restrictive Kata Agent Policy.</span>
        </div>
        <div class="cli-help-command">
          <code>cat initdata.toml</code>
          <span>Inspect the Init-Data containing the agent policy.</span>
        </div>
        <div class="cli-help-command">
          <code>${KBS_RESOURCE_POLICY_COMMAND}</code>
          <span>Provision a KBS Resource Policy.</span>
        </div>
        <div class="cli-help-command">
          <code>${ATTESTATION_POLICY_COMMAND}</code>
          <span>Provision an Attestation Service Policy.</span>
        </div>
      </div>

      <div class="cli-help-section">
        <div class="cli-help-section-title">Utilities</div>
        <div class="cli-help-command">
          <code>coco production-checklist</code>
          <span>Review the production readiness checklist.</span>
        </div>
        <div class="cli-help-command">
          <code>clear</code>
          <span>Clear the terminal.</span>
        </div>
      </div>

      <div class="cli-help-tip">
        Tip: use the guide below the terminal to walk through the official CoCo flow.
      </div>
    </div>
  `;

  const handleKubectl = async (tokens: string[]): Promise<void> => {
    const subcommand = tokens[1];

    if (subcommand === "apply" && tokens[2] === "-f") {
      const filename = tokens[3] || "";
      const content = resolveFile(filename);

      if (!content) {
        printHtml(
          `<span style="color:#ff7373;">error: file "${escapeHtml(
            filename,
          )}" not found</span>`,
        );
        return;
      }

      if (filename.endsWith("nginx.yaml")) {
        if (pods.some((pod) => pod.name === "nginx")) {
          printHtml(
            `<span style="color:#a8cfca;">pod/nginx unchanged</span>`,
          );
          markStepComplete("workload-apply");
          return;
        }

        pods.push({
          name: "nginx",
          namespace: "default",
          status: "Running",
          image: "nginx:1.29.4",
          runtimeClassName: "kata-qemu-coco-dev",
          annotations: {
            "io.containerd.cri.runtime-handler": "kata-qemu-coco-dev",
          },
        });

        addEvent(
          "Normal",
          "Created",
          "pod/nginx",
          "Created nginx using RuntimeClass kata-qemu-coco-dev",
        );
        addEvent(
          "Normal",
          "Started",
          "pod/nginx",
          "Started container nginx",
        );

        updateDashboard();
        printHtml(`<span style="color:#b8ff3c;">pod/nginx created</span>`);
        markStepComplete("workload-apply");
        return;
      }

      if (filename.endsWith("nginx-production.yaml")) {
        printHtml(
          `<span style="color:#b8ff3c;">pod/nginx-production created</span>\n` +
            `<span style="color:#a8cfca;">Simulated: requires Intel TDX hardware in a real cluster.</span>`,
        );
        return;
      }

      if (filename.endsWith("nginx-production-snp.yaml")) {
        printHtml(
          `<span style="color:#b8ff3c;">pod/nginx-production-snp created</span>\n` +
            `<span style="color:#a8cfca;">Simulated: requires AMD SEV-SNP hardware in a real cluster.</span>`,
        );
        return;
      }

      return;
    }

    if (subcommand === "get") {
      const resource = tokens[2];

      if (
        (resource === "pods" || resource === "pod") &&
        tokens.includes("-n") &&
        tokens[tokens.indexOf("-n") + 1] === "coco-system"
      ) {
        if (!helmInstalled) {
          printHtml(
            `<span style="color:#ff7373;">No resources found in coco-system.</span>`,
          );
          return;
        }

        printPre(
          `<span style="color:#00e5d4;">NAME</span>                   <span style="color:#00e5d4;">READY</span>   <span style="color:#00e5d4;">STATUS</span>\n` +
            `<span style="color:#dff7f0;">coco-controller-7d7f</span>   1/1       <span style="color:#b8ff3c;">Running</span>\n` +
            `<span style="color:#dff7f0;">coco-runtime-9k2m</span>       1/1       <span style="color:#b8ff3c;">Running</span>`,
        );
        markStepComplete("wait");
        return;
      }

      if (resource === "runtimeclass" || resource === "runtimeclasses") {
        if (!helmInstalled) {
          printHtml(
            `<span style="color:#ff7373;">No RuntimeClasses found: install CoCo first.</span>`,
          );
          return;
        }

        renderRuntimeClasses();
        markStepComplete("runtimeclasses");
        return;
      }

      if (resource === "pods" || resource === "pod") {
        const requestedName =
          resource === "pod" && tokens[3] && !tokens[3].startsWith("-")
            ? tokens[3]
            : undefined;

        const selected = requestedName
          ? pods.filter((pod) => pod.name === requestedName)
          : pods;

        if (selected.length === 0) {
          printHtml(
            `<span style="color:#ff7373;">No resources found.</span>`,
          );
          return;
        }

        printPre(
          `<span style="color:#00e5d4;">NAME</span>       <span style="color:#00e5d4;">READY</span>   <span style="color:#00e5d4;">STATUS</span>    <span style="color:#00e5d4;">RUNTIME-CLASS</span>\n` +
            selected
              .map(
                (pod) =>
                  `<span style="color:#dff7f0;">${escapeHtml(
                    pod.name.padEnd(10),
                  )}</span>   1/1       <span style="color:#b8ff3c;">${escapeHtml(
                    pod.status.padEnd(10),
                  )}</span> ${escapeHtml(pod.runtimeClassName || "<default>")}`,
              )
              .join("\n"),
        );

        if (selected.some((pod) => pod.name === "nginx")) {
          markStepComplete("workload-status");
        }
        return;
      }
    }

    if (
      subcommand === "get" &&
      tokens[2] === "pod" &&
      tokens[3] === "nginx"
    ) {
      const nginx = pods.find((pod) => pod.name === "nginx");

      if (!nginx) {
        printHtml(
          `<span style="color:#ff7373;">Error from server (NotFound): pods "nginx" not found</span>`,
        );
        return;
      }

      if (tokens.includes("jsonpath='{.spec.runtimeClassName}'")) {
        printHtml(
          `<span style="color:#b8ff3c;">kata-qemu-coco-dev</span>`,
        );
        markStepComplete("runtime-inspect");
        return;
      }
    }

    if (subcommand === "describe" && tokens[2] === "pod") {
      const name = tokens[3];
      const pod = pods.find((item) => item.name === name);

      if (!pod) {
        printHtml(
          `<span style="color:#ff7373;">Error from server (NotFound): pods "${escapeHtml(
            name || "",
          )}" not found</span>`,
        );
        return;
      }

      printPre(
        `<span style="color:#00e5d4;">Name:</span>         ${escapeHtml(pod.name)}\n` +
          `<span style="color:#00e5d4;">Namespace:</span>    ${escapeHtml(pod.namespace)}\n` +
          `<span style="color:#00e5d4;">Status:</span>       <span style="color:#b8ff3c;">${escapeHtml(pod.status)}</span>\n` +
          `<span style="color:#00e5d4;">RuntimeClass:</span> ${escapeHtml(pod.runtimeClassName || "<default>")}\n` +
          `<span style="color:#00e5d4;">Image:</span>        ${escapeHtml(pod.image)}`,
      );
      return;
    }

    if (subcommand === "delete") {
      const resource = tokens[2];
      const name = tokens[3];

      if (resource === "pod" && name) {
        const index = pods.findIndex((pod) => pod.name === name);
        if (index >= 0) {
          pods.splice(index, 1);
          addEvent(
            "Normal",
            "Deleted",
            `pod/${name}`,
            `Pod ${name} deleted`,
          );
          updateDashboard();
          printHtml(
            `<span style="color:#b8ff3c;">pod "${escapeHtml(
              name,
            )}" deleted</span>`,
          );
        } else {
          printHtml(
            `<span style="color:#ff7373;">Error from server (NotFound): pods "${escapeHtml(
              name,
            )}" not found</span>`,
          );
        }
        return;
      }
    }

    printHtml(
      `<span style="color:#ff7373;">kubectl: unsupported command in this browser demo.</span>`,
    );
  };

  const handleCommand = async (rawCommand: string) => {
    const raw = rawCommand.trim();
    if (!raw) return;

    printHtml(
      `<span style="color:#b8ff3c;">${escapeHtml(
        `${virtualDisplayPath()}$ ${raw}`,
      )}</span>`,
    );

    const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const command = tokens[0];

    if (command === "clear") {
      output.innerHTML = "";
      return;
    }

    if (command === "help" || raw === "kubectl --help") {
      printHtml(formatHelp());
      return;
    }

    if (command === "cat") {
      const file = resolveFile(tokens[1] || "");
      if (!file) {
        printHtml(
          `<span style="color:#ff7373;">cat: ${escapeHtml(
            tokens[1] || "",
          )}: No such file</span>`,
        );
        return;
      }

      printPre(escapeHtml(file));

      const name = tokens[1] || "";
      if (name.endsWith("nginx.yaml")) markStepComplete("workload-file");
      if (name.endsWith("nginx-production.yaml"))
        markStepComplete("production-tdx");
      if (name.endsWith("nginx-production-snp.yaml"))
        markStepComplete("production-snp");
      if (name.endsWith("agent-policy.rego"))
        markStepComplete("agent-policy");
      if (name.endsWith("initdata.toml")) markStepComplete("initdata");

      return;
    }

    if (command === "helm") {
      if (
        tokens[1] === "install" &&
        tokens[2] === "coco" &&
        tokens[3] ===
          "oci://ghcr.io/confidential-containers/charts/confidential-containers"
      ) {
        helmInstalled = true;

        addEvent(
          "Normal",
          "HelmInstall",
          "helm/coco",
          "Installed Confidential Containers into namespace coco-system",
        );

        printHtml(
          `<span style="color:#b8ff3c;">NAME: coco</span>\n` +
            `<span style="color:#a8cfca;">STATUS: deployed</span>\n` +
            `<span style="color:#a8cfca;">NAMESPACE: coco-system</span>`,
        );

        markStepComplete("install");
        return;
      }

      printHtml(
        `<span style="color:#ff7373;">helm: unsupported command in this browser demo.</span>`,
      );
      return;
    }

    if (command === "coco" && tokens[1] === "production-checklist") {
      printPre(
        `<span style="color:#00e5d4;">Confidential Containers production checklist</span>\n` +
          `<span style="color:#b8ff3c;">✓</span> Select the RuntimeClass that matches your TEE hardware\n` +
          `<span style="color:#b8ff3c;">✓</span> Generate/embed an appropriate Kata Agent Policy\n` +
          `<span style="color:#b8ff3c;">✓</span> Configure KBS Resource Policies\n` +
          `<span style="color:#b8ff3c;">✓</span> Provision attestation reference values\n` +
          `<span style="color:#a8cfca;">Development note:</span> kata-qemu-coco-dev provides no hardware security guarantees.`,
      );
      markStepComplete("production-checklist");
      return;
    }

    if (command === "kbs-client") {
      if (tokens.includes("set-resource-policy")) {
        printHtml(
          `<span style="color:#b8ff3c;">KBS resource policy configured.</span>\n` +
            `<span style="color:#a8cfca;">Simulated in the browser demo.</span>`,
        );
        markStepComplete("kbs-resource-policy");
        return;
      }

      if (tokens.includes("set-attestation-policy")) {
        printHtml(
          `<span style="color:#b8ff3c;">Attestation Service policy configured.</span>\n` +
            `<span style="color:#a8cfca;">Simulated in the browser demo.</span>`,
        );
        markStepComplete("attestation-policy");
        return;
      }
    }

    if (command === "kubectl") {
      await handleKubectl(tokens);
      return;
    }

    if (command === "pwd") {
      printHtml(
        `<span style="color:#dff7f0;">${escapeHtml(currentDirectory)}</span>`,
      );
      return;
    }

    if (command === "cd") {
      currentDirectory = normalizePath(tokens[1] || "/");
      prompt.innerText = `ivy@webernetes:${virtualDisplayPath()}$`;
      return;
    }

    if (command === "ls") {
      const prefix = normalizePath(tokens[1] || currentDirectory);
      const entries = new Set<string>();

      for (const file of Object.keys(localFiles)) {
        if (!file.startsWith(prefix === "/" ? "/" : `${prefix}/`)) continue;
        const remainder = file.slice(
          prefix === "/" ? 1 : prefix.length + 1,
        );
        entries.add(remainder.split("/")[0]);
      }

      printHtml(
        `<span style="color:#dff7f0;">${[...entries].sort().join("    ")}</span>`,
      );
      return;
    }

    printHtml(
      `<span style="color:#ff7373;">command not found: ${escapeHtml(
        raw,
      )}. Type 'help' to see supported commands.</span>`,
    );
  };

  guideStepList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>(
      "button[data-step-index]",
    );
    if (!button) return;

    const index = Number(button.dataset.stepIndex);
    if (Number.isFinite(index)) selectStep(index);
  });

  useCommandBtn.addEventListener("click", () => {
    const step = COCO_DEMO_STEPS[selectedIndex()];
    input.value = step.command;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  document
    .querySelector<HTMLButtonElement>("#hero-run-btn")!
    .addEventListener("click", () => {
      guidePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      input.focus();
    });

  document
    .querySelector<HTMLButtonElement>("#clear-events-btn")!
    .addEventListener("click", () => {
      events.length = 0;
      renderEvents();
    });

  const hidePanel = (
    buttonId: string,
    panelSelector: string,
    bodySelector?: string,
  ) => {
    const button = document.querySelector<HTMLButtonElement>(buttonId);
    const panel = document.querySelector<HTMLElement>(panelSelector);
    const body = bodySelector
      ? document.querySelector<HTMLElement>(bodySelector)
      : undefined;

    if (!button || !panel) return;

    button.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      if (body) body.classList.toggle("collapsed");
      button.innerText = panel.classList.contains("collapsed")
        ? "Show"
        : "Hide";
    });
  };

  hidePanel("#hide-pods-btn", "#pods-panel", "#pods-body");
  hidePanel("#hide-nodes-btn", "#nodes-panel", "#nodes-body");
  hidePanel("#hide-events-btn", "#events-panel");
  hidePanel("#hide-guide-btn", "#guide-panel", "#guide-body");

  completionClose.addEventListener("click", closeCompletionModal);
  completionBackdrop.addEventListener("click", closeCompletionModal);

  restartDemoBtn.addEventListener("click", () => {
    closeCompletionModal();
    completedSteps = new Set<string>();
    selectedStepIndex = null;
    completionShown = false;
    helmInstalled = false;

    pods = [
      {
        name: "demo-pod",
        namespace: "default",
        status: "Running",
        image: "web-server:1.0",
      },
    ];

    output.innerHTML = "";
    events.length = 0;
    addEvent(
      "Normal",
      "SessionReset",
      "demo",
      "Confidential Containers demo session reset",
    );
    updateDashboard();
    renderGuide();
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      const command = input.value;
      input.value = "";
      await handleCommand(command);
    }

    if (event.key === "Tab") {
      event.preventDefault();
    }
  });

  try {
    cluster = new Cluster();
    cluster.registerImage(WebServerImage);
    await cluster.init();

    await cluster.apply([
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "demo-pod",
          labels: { app: "demo" },
        },
        spec: {
          containers: [
            {
              name: "web",
              image: "web-server:1.0",
            },
          ],
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: "demo-service",
        },
        spec: {
          type: "NodePort",
          ports: [
            {
              port: 80,
              targetPort: 8080,
              nodePort: 31000,
              protocol: "TCP",
            },
          ],
          selector: {
            app: "demo",
          },
        },
      },
    ]);

    addEvent(
      "Normal",
      "ClusterInitialized",
      "cluster",
      "Webernetes browser cluster online",
    );
    addEvent(
      "Normal",
      "Scheduled",
      "pod/demo-pod",
      "Assigned default/demo-pod to node-2",
    );
    addEvent(
      "Normal",
      "Started",
      "pod/demo-pod",
      "Started container web",
    );

    await new Promise((resolve) => setTimeout(resolve, 500));

    updateDashboard();
    renderEvents();
    renderGuide();

    output.innerHTML = `
      <div class="terminal-block">
        <div style="color:#f8fffd;">Confidential Containers demo environment online!</div>
        <div style="color:#a8cfca;margin-top:5px;">
          This interactive terminal mirrors the official CoCo getting-started commands.
          Start with the suggested Helm install, or type <span style="color:#b8ff3c;">help</span>.
        </div>
      </div>
    `;

    input.disabled = false;
    input.focus();
  } catch (error) {
    printHtml(
      `<span style="color:#ff7373;">Failed to initialize the browser cluster: ${escapeHtml(
        String(error),
      )}</span>`,
    );
  }
}

void initTerminalDemo();
