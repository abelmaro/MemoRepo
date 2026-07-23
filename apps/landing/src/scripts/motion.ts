import {
  animate,
  inView,
  stagger,
  type AnimationPlaybackControls,
} from "motion";

const EASE_GENTLE = [0.25, 0.1, 0.25, 1] as const;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const compactMotion = window.matchMedia("(max-width: 43.75rem), (max-height: 30rem)");
const verticalFlow = window.matchMedia("(max-width: 56.25rem)");

const activeAnimations = new Set<AnimationPlaybackControls>();
const observerCleanups: Array<() => void> = [];

function markComplete(group: HTMLElement) {
  group.dataset.motionState = "complete";
}

function track(controls: AnimationPlaybackControls) {
  activeAnimations.add(controls);
  void controls.finished.finally(() => activeAnimations.delete(controls));
  return controls;
}

async function releaseWhenFinished(controls: AnimationPlaybackControls) {
  track(controls);
  try {
    await controls.finished;
  } finally {
    controls.cancel();
  }
}

function finishActiveAnimations() {
  for (const controls of activeAnimations) {
    controls.complete();
    controls.cancel();
  }
  activeAnimations.clear();

  document.querySelectorAll<SVGPathElement>("[data-motion-wire]").forEach((path) => {
    path.style.removeProperty("opacity");
  });

  document.querySelectorAll<HTMLElement>("[data-motion-group]").forEach(markComplete);
}

function itemTransition(group: HTMLElement) {
  const requestedDistance = Number(group.dataset.motionDistance);
  const distance = compactMotion.matches
    ? 8
    : Number.isFinite(requestedDistance)
      ? Math.min(requestedDistance, 15)
      : 14;
  const requestedStagger = Number(group.dataset.motionStagger);
  const staggerDelay = compactMotion.matches
    ? 0.04
    : Number.isFinite(requestedStagger)
      ? Math.min(requestedStagger, 0.065)
      : 0.06;

  return {
    distance,
    duration: compactMotion.matches ? 0.58 : 0.72,
    staggerDelay,
  };
}

function animateFlowDecoration(group: HTMLElement, kind: string) {
  const controls: AnimationPlaybackControls[] = [];
  const axis = verticalFlow.matches ? "Y" : "X";

  if (kind === "workflow") {
    const connectors = group.querySelectorAll<HTMLElement>(".workflow-list li:not(:last-child)");
    if (connectors.length > 0) {
      controls.push(
        animate(
          connectors,
          { "--motion-connector-progress": [0.52, 1] },
          {
            duration: compactMotion.matches ? 0.58 : 0.76,
            delay: stagger(compactMotion.matches ? 0.04 : 0.055),
            ease: EASE_GENTLE,
          },
        ),
      );
    }
  }

  if (kind === "architecture") {
    const rail = group.querySelector<HTMLElement>(".architecture-flow ol");
    const boundary = group.querySelector<HTMLElement>(".architecture-flow__boundary");
    if (rail) {
      controls.push(
        animate(
          rail,
          { "--motion-line-progress": [0.52, 1] },
          { duration: compactMotion.matches ? 0.62 : 0.84, ease: EASE_GENTLE },
        ),
      );
    }
    if (boundary) {
      controls.push(
        animate(
          boundary,
          { opacity: [0.68, 1] },
          { duration: compactMotion.matches ? 0.56 : 0.76, ease: EASE_GENTLE },
        ),
      );
    }
  }

  if (kind === "security") {
    const arrows = group.querySelectorAll<HTMLElement>(".security-boundary__arrow i");
    if (arrows.length > 0) {
      controls.push(
        animate(
          arrows,
          { transform: [`scale${axis}(0.62)`, `scale${axis}(1)`] },
          {
            duration: compactMotion.matches ? 0.56 : 0.76,
            delay: stagger(compactMotion.matches ? 0.045 : 0.07),
            ease: EASE_GENTLE,
          },
        ),
      );
    }
  }

  return controls;
}

function registerRevealGroup(group: HTMLElement) {
  const items = group.querySelectorAll<HTMLElement>("[data-motion-item]");
  group.dataset.motionState = "armed";

  let stopObserving: () => void = () => undefined;
  stopObserving = inView(
    group,
    () => {
      stopObserving();
      if (group.dataset.motionState === "complete" || reducedMotion.matches || items.length === 0) {
        markComplete(group);
        return;
      }

      group.dataset.motionState = "running";
      const { distance, duration, staggerDelay } = itemTransition(group);
      const kind = group.dataset.motionKind ?? "reveal";
      const startDelay = kind === "workflow" || kind === "architecture" || kind === "security" ? 0.06 : 0;
      const itemControls = animate(
        items,
        {
          opacity: [0.8, 1],
          transform: [`translateY(${distance}px)`, "translateY(0px)"],
        },
        {
          duration,
          delay: stagger(staggerDelay, { startDelay }),
          ease: EASE_GENTLE,
        },
      );
      const decorationControls = animateFlowDecoration(group, kind);

      void Promise.all([
        releaseWhenFinished(itemControls),
        ...decorationControls.map(releaseWhenFinished),
      ]).finally(() => markComplete(group));
    },
    { amount: compactMotion.matches ? 0.05 : 0.08, margin: "0px 0px 14% 0px" },
  );

  observerCleanups.push(stopObserving);
}

function registerHeroMap(group: HTMLElement) {
  group.dataset.motionState = "armed";
  let stopObserving: () => void = () => undefined;

  stopObserving = inView(
    group,
    () => {
      stopObserving();
      if (group.dataset.motionState === "complete" || reducedMotion.matches) {
        markComplete(group);
        return;
      }

      group.dataset.motionState = "running";
      const nodes = Array.from(group.querySelectorAll<HTMLElement>("[data-motion-stage]")).sort(
        (left, right) => Number(left.dataset.motionStage) - Number(right.dataset.motionStage),
      );
      const icons = nodes.flatMap((node) => Array.from(node.querySelectorAll<SVGElement>(".icon")));
      const wires = Array.from(group.querySelectorAll<SVGPathElement>("[data-motion-wire]"));
      const nodeControls = animate(
        nodes,
        { opacity: [0.78, 1] },
        {
          duration: compactMotion.matches ? 0.6 : 0.8,
          delay: stagger(compactMotion.matches ? 0.035 : 0.055),
          ease: EASE_GENTLE,
        },
      );
      const iconControls = animate(
        icons,
        { transform: ["scale(0.94)", "scale(1)"] },
        {
          duration: compactMotion.matches ? 0.58 : 0.76,
          delay: stagger(compactMotion.matches ? 0.03 : 0.045, { startDelay: 0.05 }),
          ease: EASE_GENTLE,
        },
      );

      const wireControls = animate(
        wires,
        { opacity: [0.58, 1] },
        {
          duration: compactMotion.matches ? 0.72 : 0.92,
          delay: stagger(compactMotion.matches ? 0.025 : 0.035),
          ease: EASE_GENTLE,
        },
      );

      void Promise.all([
        releaseWhenFinished(nodeControls),
        releaseWhenFinished(iconControls),
        releaseWhenFinished(wireControls),
      ]).finally(() => markComplete(group));
    },
    { amount: 0.06, margin: "0px 0px 14% 0px" },
  );

  observerCleanups.push(stopObserving);
}

function animateOpenDetails(details: HTMLDetailsElement) {
  if (!details.open || reducedMotion.matches) return;
  const content = Array.from(details.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== "SUMMARY",
  );
  if (content.length === 0) return;

  const controls = animate(
    content,
    { opacity: [0.86, 1], transform: ["translateY(-4px)", "translateY(0px)"] },
    { duration: compactMotion.matches ? 0.34 : 0.42, ease: EASE_GENTLE },
  );
  void releaseWhenFinished(controls);
}

function registerDetailsMotion() {
  document
    .querySelectorAll<HTMLDetailsElement>("[data-mobile-nav], .platform-details, .faq-list details")
    .forEach((details) => details.addEventListener("toggle", () => animateOpenDetails(details)));
}

document.querySelectorAll<HTMLElement>("[data-motion-group]").forEach((group) => {
  if (group.dataset.motionKind === "hero-map") {
    registerHeroMap(group);
  } else {
    registerRevealGroup(group);
  }
});

registerDetailsMotion();
document.documentElement.dataset.motionRuntime = reducedMotion.matches ? "reduced" : "ready";
if (reducedMotion.matches) finishActiveAnimations();

reducedMotion.addEventListener("change", () => {
  document.documentElement.dataset.motionRuntime = reducedMotion.matches ? "reduced" : "ready";
  if (reducedMotion.matches) finishActiveAnimations();
});

window.addEventListener(
  "pagehide",
  () => {
    observerCleanups.forEach((cleanup) => cleanup());
    finishActiveAnimations();
  },
  { once: true },
);
