/**
 * The state of the receipt viewer, as pure functions: rotation in quarter
 * turns, zoom, pan, and the scale at which a page fits its panel.
 *
 * Rotation is view metadata stored with the file reference; the stored file
 * itself is never rewritten. Zoom and pan are per visit and never stored.
 */

export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;
export const ZOOM_STEP = 1.25;

export interface Size {
  width: number;
  height: number;
}

export interface ViewerState {
  rotation: Rotation;
  /** Multiplier on top of the fit scale: 1 is "the whole page is visible". */
  zoom: number;
  /** Offset of the page centre from the panel centre, in panel pixels. */
  panX: number;
  panY: number;
}

/** Anything stored or sent by a browser, as a rotation. Unknown values read as "none stored". */
export function parseRotation(value: unknown): Rotation | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return ROTATIONS.includes(n as Rotation) ? (n as Rotation) : null;
}

/** A quarter turn clockwise (`1`) or counter-clockwise (`-1`). */
export function rotate(rotation: Rotation, direction: 1 | -1): Rotation {
  return (((rotation + direction * 90) % 360) + 360) % 360 as Rotation;
}

/**
 * The rotation to open a page with. A stored rotation always wins. Without
 * one, a page that is wider than tall is most likely a till receipt scanned
 * sideways, so it opens turned upright; which way round cannot be told from
 * the shape alone, so this is only a starting point and is never stored until
 * the user rotates.
 */
export function initialRotation(stored: Rotation | null, page: Size | null): Rotation {
  if (stored !== null) return stored;
  if (page && page.height > 0 && page.width / page.height >= 1.25) return 90;
  return 0;
}

/** The page's footprint after rotation: a quarter turn swaps width and height. */
export function rotatedSize(page: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: page.height, height: page.width } : page;
}

/** The scale at which the rotated page fits the panel completely. */
export function fitScale(panel: Size, page: Size, rotation: Rotation): number {
  const r = rotatedSize(page, rotation);
  if (panel.width <= 0 || panel.height <= 0 || r.width <= 0 || r.height <= 0) return 1;
  return Math.min(panel.width / r.width, panel.height / r.height);
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Keep the page from being dragged out of the panel: along an axis where the
 * zoomed page is larger than the panel it may move until its edge meets the
 * panel edge; where it is smaller it stays centred.
 */
export function clampPan(state: ViewerState, panel: Size, page: Size): ViewerState {
  const scale = fitScale(panel, page, state.rotation) * state.zoom;
  const r = rotatedSize(page, state.rotation);
  const maxX = Math.max(0, (r.width * scale - panel.width) / 2);
  const maxY = Math.max(0, (r.height * scale - panel.height) / 2);
  // `+ 0` turns a negative zero into a plain zero.
  const panX = Math.min(maxX, Math.max(-maxX, state.panX)) + 0;
  const panY = Math.min(maxY, Math.max(-maxY, state.panY)) + 0;
  return panX === state.panX && panY === state.panY ? state : { ...state, panX, panY };
}

export type ViewerAction =
  | { type: 'rotate'; direction: 1 | -1 }
  | { type: 'zoom'; direction: 1 | -1 }
  | { type: 'zoomBy'; factor: number }
  | { type: 'pan'; dx: number; dy: number }
  /** Back to "the whole page is visible". Rotation stays: it belongs to the receipt, not to the visit. */
  | { type: 'fit' }
  | { type: 'setRotation'; rotation: Rotation };

export function initialViewerState(rotation: Rotation): ViewerState {
  return { rotation, zoom: 1, panX: 0, panY: 0 };
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'rotate':
      // A turned page is shown whole again: the old pan would point somewhere else on it.
      return { rotation: rotate(state.rotation, action.direction), zoom: 1, panX: 0, panY: 0 };
    case 'setRotation':
      return state.rotation === action.rotation ? state : { rotation: action.rotation, zoom: 1, panX: 0, panY: 0 };
    case 'zoom':
      return viewerReducer(state, { type: 'zoomBy', factor: action.direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP });
    case 'zoomBy': {
      const zoom = clampZoom(state.zoom * action.factor);
      if (zoom === state.zoom) return state;
      // Zooming keeps the point at the panel centre in place.
      const ratio = zoom / state.zoom;
      return zoom === ZOOM_MIN
        ? { ...state, zoom, panX: 0, panY: 0 }
        : { ...state, zoom, panX: state.panX * ratio, panY: state.panY * ratio };
    }
    case 'pan':
      return { ...state, panX: state.panX + action.dx, panY: state.panY + action.dy };
    case 'fit':
      return state.zoom === 1 && state.panX === 0 && state.panY === 0 ? state : { ...state, zoom: 1, panX: 0, panY: 0 };
  }
}

/** What a key does while the viewer has the focus; null for keys it leaves alone. */
export function viewerKeyAction(key: string, shiftKey: boolean): ViewerAction | null {
  if (key === 'r' || key === 'R') return { type: 'rotate', direction: shiftKey || key === 'R' ? -1 : 1 };
  if (key === '+' || key === '=') return { type: 'zoom', direction: 1 };
  if (key === '-' || key === '_') return { type: 'zoom', direction: -1 };
  if (key === '0') return { type: 'fit' };
  return null;
}
