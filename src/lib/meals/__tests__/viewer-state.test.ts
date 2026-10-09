import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  clampPan,
  fitScale,
  initialRotation,
  initialViewerState,
  parseRotation,
  rotate,
  rotatedSize,
  viewerKeyAction,
  viewerReducer,
} from '../viewer-state';

const PORTRAIT = { width: 300, height: 900 };
const LANDSCAPE = { width: 900, height: 300 };
const PANEL = { width: 600, height: 900 };

describe('rotation', () => {
  it('turns in quarter steps and wraps both ways', () => {
    expect(rotate(0, 1)).toBe(90);
    expect(rotate(270, 1)).toBe(0);
    expect(rotate(0, -1)).toBe(270);
    expect(rotate(90, -1)).toBe(0);
  });

  it('reads only the four quarter turns from stored or sent values', () => {
    expect(parseRotation(90)).toBe(90);
    expect(parseRotation('270')).toBe(270);
    expect(parseRotation(0)).toBe(0);
    for (const bad of [45, 360, -90, '', 'abc', null, undefined, {}, NaN]) expect(parseRotation(bad)).toBeNull();
  });

  it('a stored rotation always wins over the guess, including a stored "upright"', () => {
    expect(initialRotation(180, LANDSCAPE)).toBe(180);
    expect(initialRotation(0, LANDSCAPE)).toBe(0);
  });

  it('without a stored rotation a clearly wide page opens turned upright, anything else as it is', () => {
    expect(initialRotation(null, LANDSCAPE)).toBe(90);
    expect(initialRotation(null, PORTRAIT)).toBe(0);
    expect(initialRotation(null, { width: 1000, height: 900 })).toBe(0);
    expect(initialRotation(null, null)).toBe(0);
  });
});

describe('fit', () => {
  it('a quarter turn swaps the footprint', () => {
    expect(rotatedSize(LANDSCAPE, 90)).toEqual(PORTRAIT);
    expect(rotatedSize(LANDSCAPE, 180)).toEqual(LANDSCAPE);
  });

  it('a sideways receipt is a thin strip; turned upright it fills the panel height', () => {
    const sideways = fitScale(PANEL, LANDSCAPE, 0);
    expect(LANDSCAPE.height * sideways).toBeCloseTo(200);
    const upright = fitScale(PANEL, LANDSCAPE, 90);
    expect(rotatedSize(LANDSCAPE, 90).height * upright).toBeCloseTo(PANEL.height);
  });

  it('never divides by an empty panel or page', () => {
    expect(fitScale({ width: 0, height: 0 }, PORTRAIT, 0)).toBe(1);
    expect(fitScale(PANEL, { width: 0, height: 10 }, 0)).toBe(1);
  });
});

describe('viewerReducer', () => {
  const start = initialViewerState(0);

  it('rotating resets zoom and pan, because the old pan points elsewhere on the turned page', () => {
    const zoomed = viewerReducer(viewerReducer(start, { type: 'zoom', direction: 1 }), { type: 'pan', dx: 40, dy: -20 });
    expect(viewerReducer(zoomed, { type: 'rotate', direction: 1 })).toEqual({ rotation: 90, zoom: 1, panX: 0, panY: 0 });
  });

  it('zoom is clamped between "whole page" and the maximum', () => {
    expect(viewerReducer(start, { type: 'zoom', direction: -1 })).toBe(start);
    let s = start;
    for (let i = 0; i < 40; i++) s = viewerReducer(s, { type: 'zoom', direction: 1 });
    expect(s.zoom).toBe(ZOOM_MAX);
    expect(viewerReducer(s, { type: 'zoom', direction: 1 })).toBe(s);
  });

  it('zooming keeps the centre point in place, and zooming all the way out recentres', () => {
    const panned = viewerReducer(viewerReducer(start, { type: 'zoomBy', factor: 2 }), { type: 'pan', dx: 100, dy: 50 });
    const closer = viewerReducer(panned, { type: 'zoomBy', factor: 2 });
    expect(closer).toMatchObject({ zoom: 4, panX: 200, panY: 100 });
    expect(viewerReducer(closer, { type: 'zoomBy', factor: 0.01 })).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
  });

  it('"fit" resets zoom and pan but keeps the rotation', () => {
    const s = viewerReducer(viewerReducer({ ...start, rotation: 270 }, { type: 'zoomBy', factor: 3 }), { type: 'pan', dx: 5, dy: 5 });
    expect(viewerReducer(s, { type: 'fit' })).toEqual({ rotation: 270, zoom: 1, panX: 0, panY: 0 });
    expect(viewerReducer(start, { type: 'fit' })).toBe(start);
  });

  it('setting the rotation it already has changes nothing', () => {
    expect(viewerReducer(start, { type: 'setRotation', rotation: 0 })).toBe(start);
    expect(viewerReducer(start, { type: 'setRotation', rotation: 180 }).rotation).toBe(180);
  });
});

describe('clampPan', () => {
  it('a page that fits stays centred however far it is dragged', () => {
    expect(clampPan({ rotation: 0, zoom: 1, panX: 300, panY: -300 }, PANEL, PORTRAIT)).toMatchObject({ panX: 0, panY: 0 });
  });

  it('a zoomed page moves until its edge meets the panel edge', () => {
    // Fit scale 1 (300x900 in 600x900); zoom 4 gives 1200x3600: 300 of slack sideways, 1350 up and down.
    const s = clampPan({ rotation: 0, zoom: 4, panX: 9999, panY: -9999 }, PANEL, PORTRAIT);
    expect(s).toMatchObject({ panX: 300, panY: -1350 });
    const inside = { rotation: 0 as const, zoom: 4, panX: 10, panY: 10 };
    expect(clampPan(inside, PANEL, PORTRAIT)).toBe(inside);
  });
});

describe('keyboard', () => {
  it('r rotates clockwise, Shift+r back; plus and minus zoom; 0 fits', () => {
    expect(viewerKeyAction('r', false)).toEqual({ type: 'rotate', direction: 1 });
    expect(viewerKeyAction('R', true)).toEqual({ type: 'rotate', direction: -1 });
    expect(viewerKeyAction('+', false)).toEqual({ type: 'zoom', direction: 1 });
    expect(viewerKeyAction('=', false)).toEqual({ type: 'zoom', direction: 1 });
    expect(viewerKeyAction('-', false)).toEqual({ type: 'zoom', direction: -1 });
    expect(viewerKeyAction('0', false)).toEqual({ type: 'fit' });
  });

  it('leaves every other key alone', () => {
    for (const key of ['a', 'Enter', 'Tab', ' ', 'ArrowLeft', '1']) expect(viewerKeyAction(key, false)).toBeNull();
  });
});
