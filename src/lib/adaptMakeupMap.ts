import type {
  MakeupMap,
  MakeupStep,
  Overlay,
  OverlayStyle,
  ProductInfo,
} from "../types/makeup";

/**
 * Adapter: enrich a compact hand-authored makeup map into the full `MakeupMap`
 * the UI + canvas renderer require.
 *
 * The compact schema only specifies landmark placement plus a simple `color` /
 * `lineWidth` per overlay. This adapter maps those into the renderer's internal
 * `style` object (stroke for lines, fill for circles) and fills in product
 * names, swatch colors, and instructions from per-category defaults — while
 * PRESERVING any richer fields that are provided explicitly.
 */

/** Loose, defensive shape of the compact input — everything optional. */
interface RawAnchor {
  landmark: number;
  offset?: { x: number; y: number };
}
interface RawOverlay {
  overlayId?: string;
  type: "polyline" | "circle" | "ellipse";
  /** Simple single color; mapped to stroke (outline) or fill (see `filled`). */
  color?: string;
  /** Simple line width; mapped into style.lineWidth. */
  lineWidth?: number;
  /** Draw dashed (compact shorthand for style.dashed). */
  dashed?: boolean;
  /** For circle/ellipse: fill the shape instead of drawing it as an outline. */
  filled?: boolean;
  /** Optional full style block; takes precedence over color/lineWidth. */
  style?: Partial<OverlayStyle>;
  anchors?: RawAnchor[];
  center?: RawAnchor;
  radiusLandmark?: number;
  /** Ellipse only: the perpendicular semi-axis reference landmark. */
  ryLandmark?: number;
}
interface RawStep {
  stepId: string;
  order?: number;
  name?: string;
  instruction?: string;
  product?: Partial<ProductInfo>;
  overlays?: RawOverlay[];
  /** Optional reference photo URL for the step. */
  imageUrl?: string | null;
}
export interface RawMakeupMap {
  mapId?: string;
  metadata?: { title?: string; difficulty?: string; estimatedMinutes?: number };
  steps?: RawStep[];
}

/** Per-category cosmetic defaults keyed by a normalized category name. */
interface CategoryDefaults {
  name: string;
  product: ProductInfo;
  instruction: string;
  style: OverlayStyle;
}

const CATEGORY_DEFAULTS: Record<string, CategoryDefaults> = {
  contour: {
    name: "Contour",
    product: {
      name: "Cool-toned contour powder",
      category: "contour",
      swatchColor: "rgba(139, 107, 90, 0.85)",
    },
    instruction: "Apply along the cheekbone hollow and blend upward.",
    style: { stroke: "rgba(139, 107, 90, 0.9)", lineWidth: 3, dashed: true, opacity: 0.85 },
  },
  blush: {
    name: "Blush",
    product: {
      name: "Peach blush",
      category: "blush",
      swatchColor: "rgba(232, 154, 140, 0.6)",
    },
    instruction: "Smile and apply to the apples of the cheeks.",
    style: {
      fill: "rgba(232, 154, 140, 0.3)",
      stroke: "rgba(232, 154, 140, 0.85)",
      lineWidth: 2,
      dashed: true,
    },
  },
  highlight: {
    name: "Highlight",
    product: {
      name: "Champagne highlighter",
      category: "highlight",
      swatchColor: "rgba(255, 240, 200, 0.7)",
    },
    instruction: "Dab onto the high points of the cheekbones and brow bone.",
    style: {
      fill: "rgba(255, 240, 200, 0.35)",
      stroke: "rgba(255, 240, 200, 0.9)",
      lineWidth: 2,
      dashed: true,
    },
  },
  brighten: {
    name: "Brighten",
    product: {
      name: "Brightening concealer",
      category: "brighten",
      swatchColor: "rgba(255, 250, 240, 0.75)",
    },
    instruction: "Highlight your forehead, nose bridge, and chin.",
    style: {
      fill: "rgba(255, 250, 240, 0.4)",
      stroke: "rgba(255, 250, 240, 0.9)",
      lineWidth: 4,
      dashed: false,
    },
  },
};

/** Fallback for any step whose category we don't recognize. */
const GENERIC_DEFAULTS: CategoryDefaults = {
  name: "Step",
  product: { name: "Product", category: "makeup", swatchColor: "rgba(255, 59, 127, 0.6)" },
  instruction: "Follow the guide on your face.",
  style: {
    stroke: "rgba(255, 59, 127, 0.9)",
    fill: "rgba(255, 59, 127, 0.25)",
    lineWidth: 2,
    dashed: true,
  },
};

function titleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Resolve category defaults from a stepId like "contour" or "step-02-blush". */
function defaultsForStep(stepId: string): CategoryDefaults {
  const key = Object.keys(CATEGORY_DEFAULTS).find((k) => stepId.toLowerCase().includes(k));
  return key ? CATEGORY_DEFAULTS[key] : GENERIC_DEFAULTS;
}

function adaptOverlay(raw: RawOverlay, index: number, defaults: CategoryDefaults): Overlay {
  const overlayId = raw.overlayId ?? `overlay-${index}`;

  // Start from category defaults, then layer on the simple color/lineWidth, then
  // any explicit `style` block (highest precedence).
  const style: OverlayStyle = { ...defaults.style };
  if (raw.color) {
    // Closed shapes fill when `filled`, otherwise they (and all lines) stroke as
    // an outline. Clear the unused channel so a category default can't re-fill an
    // outline or vice-versa.
    const wantsFill = (raw.type === "circle" || raw.type === "ellipse") && raw.filled === true;
    if (wantsFill) {
      style.fill = raw.color;
      style.stroke = undefined;
    } else {
      style.stroke = raw.color;
      style.fill = undefined;
    }
  }
  if (raw.lineWidth !== undefined) style.lineWidth = raw.lineWidth;
  // The compact schema implies solid strokes unless `dashed` (or a style block)
  // says otherwise.
  style.dashed = raw.dashed ?? raw.style?.dashed ?? false;
  Object.assign(style, raw.style);

  if (raw.type === "circle") {
    return {
      overlayId,
      type: "circle",
      style,
      center: raw.center ?? { landmark: 0 },
      radiusLandmark: raw.radiusLandmark ?? 0,
    };
  }
  if (raw.type === "ellipse") {
    return {
      overlayId,
      type: "ellipse",
      style,
      center: raw.center ?? { landmark: 0 },
      radiusLandmark: raw.radiusLandmark ?? 0,
      ryLandmark: raw.ryLandmark ?? 0,
    };
  }
  return { overlayId, type: "polyline", style, anchors: raw.anchors ?? [] };
}

/**
 * Convert a compact raw map into a fully-typed, render-ready MakeupMap.
 * Throws if the input has no usable steps so callers can fall back to a sample.
 */
export function adaptMakeupMap(raw: RawMakeupMap): MakeupMap {
  if (!raw.steps || raw.steps.length === 0) {
    throw new Error("Makeup map has no steps.");
  }

  const steps: MakeupStep[] = raw.steps.map((rawStep, i) => {
    const defaults = defaultsForStep(rawStep.stepId ?? `step-${i}`);

    // Prefer an explicit swatch; otherwise reflect the step's first overlay color.
    const firstColor = rawStep.overlays?.find((o) => o.color)?.color;
    const product: ProductInfo = { ...defaults.product, ...rawStep.product };
    if (!rawStep.product?.swatchColor && firstColor) {
      product.swatchColor = firstColor;
    }

    return {
      stepId: rawStep.stepId ?? `step-${i + 1}`,
      order: rawStep.order ?? i + 1,
      name: rawStep.name ?? titleCase(rawStep.stepId ?? defaults.name),
      product,
      instruction: rawStep.instruction ?? defaults.instruction,
      overlays: (rawStep.overlays ?? []).map((o, oi) => adaptOverlay(o, oi, defaults)),
      imageUrl: rawStep.imageUrl ?? null,
    };
  });

  return {
    mapId: raw.mapId ?? "custom-look",
    metadata: {
      title: raw.metadata?.title ?? titleCase(raw.mapId ?? "Custom Look"),
      difficulty: raw.metadata?.difficulty,
      estimatedMinutes: raw.metadata?.estimatedMinutes,
    },
    steps,
  };
}
