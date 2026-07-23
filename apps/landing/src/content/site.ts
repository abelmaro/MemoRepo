import rootPackage from "../../../../package.json";

type HttpsUrl = `https://${string}`;
type HttpUrl = `http://${string}`;
type SectionHref = `#${string}`;
type LinkHref = HttpsUrl | HttpUrl | SectionHref;

type Link = {
  readonly label: string;
  readonly href: LinkHref;
};

type TitledCopy = {
  readonly title: string;
  readonly body: string;
};

type CodeBlock = {
  readonly title: string;
  readonly language: "bash" | "dotenv" | "powershell";
  readonly code: string;
  readonly description?: string;
};

type Five<T> = readonly [T, T, T, T, T];
type Six<T> = readonly [T, T, T, T, T, T];
type Seven<T> = readonly [T, T, T, T, T, T, T];
type Eight<T> = readonly [T, T, T, T, T, T, T, T];

export interface SiteContent {
  readonly links: {
    readonly repository: HttpsUrl;
    readonly quickstart: HttpsUrl;
    readonly mcpTools: HttpsUrl;
    readonly operatingContract: HttpsUrl;
    readonly changelog: HttpsUrl;
    readonly securityPolicy: HttpsUrl;
    readonly vulnerabilityReport: HttpsUrl;
    readonly issues: HttpsUrl;
    readonly license: HttpsUrl;
    readonly localDashboard: HttpUrl;
  };
  readonly metadata: {
    readonly language: "en";
    readonly siteName: string;
    readonly title: string;
    readonly description: string;
    readonly socialDescription: string;
  };
  readonly ui: {
    readonly skipToContent: string;
    readonly openNavigation: string;
    readonly closeNavigation: string;
    readonly copyCode: string;
    readonly copied: string;
    readonly copyFailed: string;
    readonly externalLinkNotice: string;
  };
  readonly header: {
    readonly brand: string;
    readonly brandLinkLabel: string;
    readonly navigationLabel: string;
    readonly navigation: Five<Link>;
    readonly cta: Link;
  };
  readonly hero: {
    readonly eyebrow: string;
    readonly title: string;
    readonly body: string;
    readonly support: string;
    readonly primaryCta: Link;
    readonly secondaryCta: Link;
    readonly visualAlt: string;
    readonly visualCaption: string;
  };
  readonly problems: {
    readonly id: "why";
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly items: readonly [TitledCopy, TitledCopy, TitledCopy];
    readonly conclusion: string;
  };
  readonly features: {
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly items: Six<TitledCopy>;
  };
  readonly workflow: {
    readonly id: "how-it-works";
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly steps: Five<TitledCopy & { readonly number: string }>;
    readonly optionalNoteTitle: string;
    readonly optionalNote: string;
  };
  readonly architecture: {
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly boundaryLabel: string;
    readonly boundarySupport: string;
    readonly nodes: Seven<{
      readonly label: string;
      readonly boundary: "inside" | "outside";
    }>;
    readonly statements: readonly [string, string];
    readonly textAlternativeLabel: string;
    readonly textAlternative: string;
  };
  readonly security: {
    readonly id: "security";
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly controls: Six<TitledCopy>;
    readonly calloutTitle: string;
    readonly callout: string;
    readonly actions: readonly [Link, Link, Link];
  };
  readonly scope: {
    readonly title: string;
    readonly intro: string;
    readonly builtForTitle: string;
    readonly builtFor: Six<string>;
    readonly notBuiltForTitle: string;
    readonly notBuiltFor: Five<string>;
    readonly conclusion: string;
  };
  readonly quickstart: {
    readonly id: "quickstart";
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly requirementsLabel: string;
    readonly requirements: readonly [string, string];
    readonly blocks: readonly [CodeBlock, CodeBlock, CodeBlock, CodeBlock];
    readonly powershellTitle: string;
    readonly powershellIntro: string;
    readonly powershellBlocks: readonly [CodeBlock, CodeBlock];
    readonly tokenNote: string;
    readonly optionalTokenTitle: string;
    readonly optionalTokenBody: string;
    readonly optionalTokenBlock: CodeBlock;
    readonly afterStart: string;
    readonly action: Link;
  };
  readonly faq: {
    readonly id: "faq";
    readonly title: string;
    readonly intro: string;
    readonly items: Seven<{
      readonly question: string;
      readonly answer: string;
    }>;
  };
  readonly finalCta: {
    readonly eyebrow: string;
    readonly title: string;
    readonly body: string;
    readonly primaryCta: Link;
    readonly secondaryCta: Link;
  };
  readonly docs: {
    readonly id: "docs";
    readonly eyebrow: string;
    readonly title: string;
    readonly intro: string;
    readonly items: Five<Link & { readonly description: string }>;
  };
  readonly footer: {
    readonly brand: string;
    readonly tagline: string;
    readonly navigationLabel: string;
    readonly navigation: Eight<Link>;
    readonly licenseNotice: string;
    readonly versionLabel: string;
    readonly version: string;
  };
}

export const siteContent = {
  links: {
    repository: "https://github.com/abelmaro/MemoRepo",
    quickstart:
      "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
    mcpTools:
      "https://github.com/abelmaro/MemoRepo/blob/main/docs/mcp-tools.md",
    operatingContract:
      "https://github.com/abelmaro/MemoRepo/blob/main/docs/operating-contract.md",
    changelog: "https://github.com/abelmaro/MemoRepo/blob/main/CHANGELOG.md",
    securityPolicy: "https://github.com/abelmaro/MemoRepo/security/policy",
    vulnerabilityReport:
      "https://github.com/abelmaro/MemoRepo/security/advisories/new",
    issues: "https://github.com/abelmaro/MemoRepo/issues",
    license: "https://github.com/abelmaro/MemoRepo/blob/main/LICENSE",
    localDashboard: "http://127.0.0.1:5173",
  },
  metadata: {
    language: "en",
    siteName: "MemoRepo",
    title: "MemoRepo — Cross-repository context for coding agents",
    description:
      "MemoRepo turns related GitHub repositories into immutable, source-verifiable context for coding agents through a local, read-only MCP gateway.",
    socialDescription:
      "Give coding agents reproducible context across related repositories through immutable snapshots and a read-only MCP gateway.",
  },
  ui: {
    skipToContent: "Skip to main content",
    openNavigation: "Open navigation",
    closeNavigation: "Close navigation",
    copyCode: "Copy",
    copied: "Copied",
    copyFailed: "Could not copy",
    externalLinkNotice: "opens in a new tab",
  },
  header: {
    brand: "MemoRepo",
    brandLinkLabel: "MemoRepo home",
    navigationLabel: "Primary navigation",
    navigation: [
      { label: "Why MemoRepo", href: "#why" },
      { label: "How it works", href: "#how-it-works" },
      { label: "Security", href: "#security" },
      { label: "Quickstart", href: "#quickstart" },
      { label: "Docs", href: "#docs" },
    ],
    cta: {
      label: "View on GitHub",
      href: "https://github.com/abelmaro/MemoRepo",
    },
  },
  hero: {
    eyebrow: "LOCAL-FIRST · READ-ONLY MCP · OPEN SOURCE",
    title: "Give coding agents cross-repository context they can trust.",
    body:
      "MemoRepo groups related GitHub repositories into isolated Spaces, records the exact commits behind selected branches, and exposes graph-guided discovery plus verifiable snapshot source through a bounded, read-only Model Context Protocol (MCP) gateway.",
    support:
      "Designed for one developer on one workstation. Runs locally with Docker Compose on Windows, macOS, and Linux.",
    primaryCta: {
      label: "View MemoRepo on GitHub",
      href: "https://github.com/abelmaro/MemoRepo",
    },
    secondaryCta: {
      label: "Read the quickstart",
      href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
    },
    visualAlt:
      "MemoRepo dashboard showing a Space with repositories, snapshot status, and agent connection controls.",
    visualCaption:
      "One Space. Multiple repositories. One active, reproducible snapshot.",
  },
  problems: {
    id: "why",
    eyebrow: "THE CONTEXT GAP",
    title: "An agent is only as reliable as the context it can inspect.",
    intro:
      "Modern systems rarely fit inside one repository. Services, packages, schemas, clients, and infrastructure evolve independently, while many agent workflows see only the current working tree or receive access far broader than the question requires.",
    items: [
      {
        title: "Fragmented context",
        body: "Repository boundaries hide the relationships an agent needs to understand a system end to end.",
      },
      {
        title: "Moving evidence",
        body: "Live branches change. Without a recorded revision, the evidence behind an answer is difficult to reproduce.",
      },
      {
        title: "Over-broad access",
        body: "General filesystem and shell access expands the trust boundary without making the context more precise.",
      },
    ],
    conclusion:
      "MemoRepo creates a stable, scoped read model from only the repositories you select.",
  },
  features: {
    eyebrow: "WHY MEMOREPO",
    title: "Built around evidence, scope, and repeatability.",
    intro:
      "MemoRepo treats code context as an operational artifact: selected deliberately, built reproducibly, inspected visibly, and exposed through a narrow interface.",
    items: [
      {
        title: "One Space, many repositories",
        body: "Group related repositories into one shared context. Search across the snapshot or narrow the question to one project.",
      },
      {
        title: "Exact-commit snapshots",
        body: "MemoRepo records resolved commits and activates a replacement only after the complete snapshot succeeds.",
      },
      {
        title: "Graph discovery, source truth",
        body: "Discover relationships in the graph, then verify important claims against the immutable source snapshot.",
      },
      {
        title: "Read-only by construction",
        body: "Each connection reads one Space through bounded query tools—without shell, editor, or write access.",
      },
      {
        title: "Local control",
        body: "Clones, indexes, state, and credentials remain local. Agent configs receive only Space-scoped access.",
      },
      {
        title: "Visible recovery",
        body: "Track snapshot quality, jobs, retries, cleanup, and recovery from the dashboard.",
      },
    ],
  },
  workflow: {
    id: "how-it-works",
    eyebrow: "HOW IT WORKS",
    title: "From repositories to agent-ready context in five steps.",
    intro:
      "MemoRepo manages the operational path from authorized GitHub access to a bounded query connection.",
    steps: [
      {
        number: "01",
        title: "Connect GitHub",
        body: "Use GitHub Device Flow or a read-capable token. Only granted repositories are visible.",
      },
      {
        number: "02",
        title: "Create a Space",
        body: "Create a named context for the product or domain the repositories form together.",
      },
      {
        number: "03",
        title: "Add related repositories",
        body: "Choose repositories and branches. MemoRepo records the exact commit behind each selection.",
      },
      {
        number: "04",
        title: "Build the immutable snapshot",
        body: "Build and index one immutable snapshot. It activates only after the complete build succeeds.",
      },
      {
        number: "05",
        title: "Connect an agent",
        body: "Generate a Space-scoped MCP connection and give the client its separate read-only token.",
      },
    ],
    optionalNoteTitle: "Optional: Ask this Space",
    optionalNote:
      "Chats stay pinned to the snapshot active at creation. External inference starts only after disclosure and explicit consent.",
  },
  architecture: {
    eyebrow: "ARCHITECTURE",
    title: "A narrow path from source to answer.",
    intro:
      "The local boundary contains the stateful control plane and the read-only agent gateway; source acquisition and the MCP-compatible client sit outside it.",
    boundaryLabel: "Local MemoRepo boundary",
    boundarySupport: "Also inside: dashboard and control API · SQLite state",
    nodes: [
      { label: "GitHub repositories", boundary: "outside" },
      { label: "MemoRepo-managed local clones", boundary: "inside" },
      {
        label: "Exact-commit, content-addressed source trees",
        boundary: "inside",
      },
      { label: "Immutable Space snapshot", boundary: "inside" },
      {
        label: "Shared code graph and direct source verification",
        boundary: "inside",
      },
      {
        label: "Space-scoped read-only MCP gateway",
        boundary: "inside",
      },
      { label: "MCP-compatible coding agent", boundary: "outside" },
    ],
    statements: [
      "Graph discovery accelerates investigation. Immutable source is the authority for exact claims; exhaustive and negative claims also require complete coverage, untruncated results, and finished pagination.",
      "Repository credentials are not embedded in generated MCP configurations.",
    ],
    textAlternativeLabel: "Architecture flow",
    textAlternative:
      "GitHub repositories are cloned into MemoRepo's local boundary, which also contains the dashboard, control API, and SQLite state. MemoRepo records selected-branch commits, materializes exact trees in a content-addressed store, builds one immutable Space snapshot, and combines a shared code graph with direct source verification. A Space-scoped read-only MCP gateway then serves the active snapshot to an MCP-compatible coding agent outside the MemoRepo boundary.",
  },
  security: {
    id: "security",
    eyebrow: "SUPPORTED SECURITY BOUNDARY",
    title: "Narrow by design. Explicit about its limits.",
    intro:
      "MemoRepo reduces the agent-facing surface by separating control access from snapshot query access and exposing only bounded, read-only MCP tools.",
    controls: [
      {
        title: "Localhost by default",
        body: "The dashboard and API bind to the local machine in the supported Docker Compose setup.",
      },
      {
        title: "Separate credentials",
        body: "The control plane and each MCP connection use separate bearer credentials. Deleting a connection revokes its token independently.",
      },
      {
        title: "Repository credentials stay out of agent configs",
        body: "Repository-access credentials are not included in generated MCP configurations or normal model prompt and tool payloads. The MemoRepo control token is also excluded from model payloads.",
      },
      {
        title: "No general-purpose execution surface",
        body: "The MCP gateway does not expose a shell, terminal, editor, arbitrary filesystem browser, web browser, external app gateway, or write operations.",
      },
      {
        title: "Validated and redacted source access",
        body: "Snapshot tools accept bounded repository-relative inputs, reject unsafe paths, and sanitize internal paths from normal responses.",
      },
      {
        title: "Explicit external-inference consent",
        body: "Optional in-dashboard inference starts only after a disclosure explains that questions, chat history, query results, and relevant code excerpts may be sent to the selected provider.",
      },
    ],
    calloutTitle: "Supported deployment boundary",
    callout:
      "MemoRepo is designed for trusted local use by one developer on one workstation. It is not a supported public, network-exposed, reverse-proxied, or multi-user service.",
    actions: [
      {
        label: "Read the operating contract",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/operating-contract.md",
      },
      {
        label: "Review the security policy",
        href: "https://github.com/abelmaro/MemoRepo/security/policy",
      },
      {
        label: "Report a vulnerability privately",
        href: "https://github.com/abelmaro/MemoRepo/security/advisories/new",
      },
    ],
  },
  scope: {
    title: "A focused control plane—not another autonomous agent.",
    intro:
      "MemoRepo manages local code context and exposes a narrow read model. The MCP-compatible client remains the agent.",
    builtForTitle: "Built for",
    builtFor: [
      "Local developer workstations",
      "Related GitHub repositories",
      "Read-only investigation",
      "MCP-compatible coding agents",
      "Reproducible architecture and source evidence",
      "Visible snapshot and job operations",
    ],
    notBuiltForTitle: "Intentionally not built for",
    notBuiltFor: [
      "Editing, committing, pushing, merging, or opening pull requests",
      "Public hosting or multi-user tenancy",
      "General shell, terminal, or arbitrary filesystem access",
      "Bypassing GitHub permissions",
      "Following remote changes before a replacement snapshot succeeds",
    ],
    conclusion:
      "The boundary is part of the product—not a limitation hidden behind marketing copy.",
  },
  quickstart: {
    id: "quickstart",
    eyebrow: "QUICKSTART",
    title: "Run MemoRepo locally with Docker Compose.",
    intro:
      "Start from a clean checkout. Productive local use requires Docker Desktop or Docker Engine; direct Node workspace execution is for development.",
    requirementsLabel: "You need",
    requirements: [
      "Docker Desktop on Windows or macOS, or Docker Engine or Desktop on Linux.",
      "A GitHub account with access to the repositories you want to index.",
    ],
    blocks: [
      {
        title: "Clone the repository",
        language: "bash",
        code: "git clone https://github.com/abelmaro/MemoRepo.git\ncd MemoRepo",
      },
      {
        title: "Prepare the environment",
        language: "bash",
        code: "cp .env.example .env",
      },
      {
        title: "Generate the control token",
        language: "bash",
        code: "openssl rand -hex 32",
      },
      {
        title: "Start MemoRepo",
        language: "bash",
        code: "docker compose up --build",
      },
    ],
    powershellTitle: "PowerShell 7",
    powershellIntro:
      "Use the native file-copy command and cryptographic token generator on Windows.",
    powershellBlocks: [
      {
        title: "Prepare the environment",
        language: "powershell",
        code: "Copy-Item .env.example .env",
      },
      {
        title: "Generate the control token",
        language: "powershell",
        code: "[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()",
      },
    ],
    tokenNote:
      "Set the generated value in .env as MEMOREPO_CONTROL_TOKEN. Treat the control token and generated MCP configurations as local secrets.",
    optionalTokenTitle: "Optional: use an existing GitHub token",
    optionalTokenBody:
      "Set GH_TOKEN only when you want to skip the default OAuth Device Flow. It must be able to read every repository you plan to index and takes priority over a stored OAuth credential.",
    optionalTokenBlock: {
      title: "Set an existing GitHub token",
      language: "dotenv",
      code: "GH_TOKEN=your-github-token",
    },
    afterStart:
      "Open http://127.0.0.1:5173, unlock the dashboard with the control token, connect GitHub, create a Space, add repositories, wait for the immutable snapshot to become active, and generate a read-only MCP connection.",
    action: {
      label: "Open the complete quickstart",
      href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
    },
  },
  faq: {
    id: "faq",
    title: "Questions engineers usually ask first.",
    intro:
      "The short answers below reflect MemoRepo's documented local operating contract.",
    items: [
      {
        question: "What problem does MemoRepo solve?",
        answer:
          "It gives coding agents one reproducible context across related repositories, with graph-guided discovery, direct source verification, and a read-only MCP boundary.",
      },
      {
        question: "Is MemoRepo a coding agent?",
        answer:
          "No. MemoRepo prepares and serves bounded code context. Your MCP-compatible client remains the agent that asks questions and uses the returned evidence.",
      },
      {
        question: "Can an agent modify my repositories through MemoRepo?",
        answer:
          "No. The MCP gateway does not expose source editing, commits, pushes, merges, pull requests, a shell, or arbitrary filesystem access. The control plane separately manages its own local clones, snapshots, jobs, and SQLite state.",
      },
      {
        question: "Does repository content leave my machine?",
        answer:
          "Core clones, snapshots, indexes, and operational state remain local. Optional Ask this Space inference can send disclosed questions, chat history, query results, and relevant code excerpts to the selected provider after explicit consent. Repository-access credentials and the MemoRepo control token are excluded from those model payloads.",
      },
      {
        question: "How does MemoRepo keep context reproducible?",
        answer:
          "MCP tools read the Space's active immutable snapshot rather than a live working tree, and initialization reports its version. A successful rebuild can change the active snapshot used by later MCP calls. Ask this Space chats remain pinned to the snapshot active when they were created.",
      },
      {
        question: "Is public or multi-user deployment supported?",
        answer:
          "No. The supported target is trusted local use by one developer on one workstation through Docker Compose.",
      },
      {
        question: "Which operating systems are supported?",
        answer:
          "Windows and macOS through Docker Desktop, and Linux through Docker Engine or Docker Desktop.",
      },
    ],
  },
  finalCta: {
    eyebrow: "START WITH A SPACE",
    title: "Better context. Smaller trust boundary.",
    body: "Give your coding agent one reproducible view of the repositories that belong together—without giving it control of your source.",
    primaryCta: {
      label: "View MemoRepo on GitHub",
      href: "https://github.com/abelmaro/MemoRepo",
    },
    secondaryCta: {
      label: "Read the quickstart",
      href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
    },
  },
  docs: {
    id: "docs",
    eyebrow: "DOCUMENTATION",
    title: "Inspect the operating contract before you connect an agent.",
    intro:
      "The repository documentation defines setup, tool behavior, limits, releases, and the supported security boundary.",
    items: [
      {
        label: "Quickstart",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
        description:
          "Installation, GitHub connection, Spaces, agent connections, and troubleshooting.",
      },
      {
        label: "MCP tools",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/mcp-tools.md",
        description:
          "Connection modes, query contracts, completeness rules, limits, and recommended workflow.",
      },
      {
        label: "Operating contract",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/operating-contract.md",
        description:
          "Runtime support, configuration, data ownership, trust boundaries, and security.",
      },
      {
        label: "Changelog",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/CHANGELOG.md",
        description: "Releases and notable product changes.",
      },
      {
        label: "Security policy",
        href: "https://github.com/abelmaro/MemoRepo/security/policy",
        description:
          "Supported versions, private vulnerability reporting, and security scope.",
      },
    ],
  },
  footer: {
    brand: "MemoRepo",
    tagline: "Local-first, read-only code intelligence for coding agents.",
    navigationLabel: "Project links",
    navigation: [
      {
        label: "GitHub repository",
        href: "https://github.com/abelmaro/MemoRepo",
      },
      {
        label: "Quickstart",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/quickstart.md",
      },
      {
        label: "MCP tools",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/mcp-tools.md",
      },
      {
        label: "Operating contract",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/docs/operating-contract.md",
      },
      {
        label: "Changelog",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/CHANGELOG.md",
      },
      {
        label: "Security policy",
        href: "https://github.com/abelmaro/MemoRepo/security/policy",
      },
      {
        label: "Issues",
        href: "https://github.com/abelmaro/MemoRepo/issues",
      },
      {
        label: "MIT License",
        href: "https://github.com/abelmaro/MemoRepo/blob/main/LICENSE",
      },
    ],
    licenseNotice: "Free and open source under the MIT License.",
    versionLabel: "Current build:",
    version: rootPackage.version,
  },
} as const satisfies SiteContent;
