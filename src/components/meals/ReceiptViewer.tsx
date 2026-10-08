'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { renderPdfPage } from '@/lib/meals/pdf-render';
import {
  clampPan,
  fitScale,
  initialRotation,
  initialViewerState,
  viewerKeyAction,
  viewerReducer,
  type Rotation,
  type Size,
  type ViewerAction,
} from '@/lib/meals/viewer-state';

/** One receipt file as the viewer needs it. */
export interface ViewerFile {
  /** Id of the file reference; the rotation is stored on it. */
  refId: string;
  fileId: string;
  fileUrl: string;
  mimeType: string;
  originalName: string;
  rotation: Rotation | null;
}

const TEXT = {
  de: {
    viewer: 'Belegansicht',
    none: 'Zu diesem Beleg ist keine Datei hinterlegt.',
    loading: 'Beleg wird geladen…',
    failed: (name: string) => `Der Beleg „${name}“ konnte nicht geladen werden.`,
    openTab: 'In neuem Tab öffnen',
    rotateLeft: 'Nach links drehen',
    rotateRight: 'Nach rechts drehen',
    zoomOut: 'Verkleinern',
    zoomIn: 'Vergrößern',
    fit: 'Einpassen',
    file: (n: number) => `Datei ${n}`,
    page: (n: number, of: number) => `Seite ${n} von ${of}`,
    prevPage: 'Vorherige Seite',
    nextPage: 'Nächste Seite',
    alt: (name: string) => `Beleg ${name}`,
    saveFailed: 'Die Drehung konnte nicht gespeichert werden. Sie gilt nur für diese Ansicht.',
    keys: 'Tasten: R dreht, Plus und Minus zoomen, 0 passt ein. Ziehen verschiebt.',
    status: (rotation: number, zoom: number) => `Gedreht um ${rotation} Grad, Zoom ${zoom} Prozent.`,
  },
  en: {
    viewer: 'Receipt viewer',
    none: 'No file is attached to this receipt.',
    loading: 'Loading receipt…',
    failed: (name: string) => `The receipt "${name}" could not be loaded.`,
    openTab: 'Open in a new tab',
    rotateLeft: 'Rotate left',
    rotateRight: 'Rotate right',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    fit: 'Fit',
    file: (n: number) => `File ${n}`,
    page: (n: number, of: number) => `Page ${n} of ${of}`,
    prevPage: 'Previous page',
    nextPage: 'Next page',
    alt: (name: string) => `Receipt ${name}`,
    saveFailed: 'The rotation could not be saved. It applies to this view only.',
    keys: 'Keys: R rotates, plus and minus zoom, 0 fits. Drag to move.',
    status: (rotation: number, zoom: number) => `Rotated by ${rotation} degrees, zoom ${zoom} percent.`,
  },
} as const;

interface ReceiptViewerProps {
  files: ViewerFile[];
  /**
   * Store the rotation of a file. Resolves false when it could not be stored;
   * the view stays turned and says so. Without it the viewer does not offer
   * to keep a rotation (read-only surfaces).
   */
  onRotate?: (file: ViewerFile, rotation: Rotation) => Promise<boolean>;
  lang?: keyof typeof TEXT;
  /** Height and placement of the panel; the viewer fills whatever it is given. */
  className?: string;
}

/**
 * The receipt beside the form: one picture that can be turned in quarter
 * steps, zoomed, dragged and fitted. A PDF receipt is drawn to a picture
 * first, so both kinds behave the same.
 */
export default function ReceiptViewer({ files, onRotate, lang = 'de', className }: ReceiptViewerProps) {
  const t = TEXT[lang];
  const [index, setIndex] = useState(0);
  const file = files[Math.min(index, files.length - 1)];

  if (!file) {
    return (
      <div className={`ui-viewer ui-viewer-empty ${className ?? ''}`.trim()}>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {t.none}
        </p>
      </div>
    );
  }

  return (
    <div className={`ui-viewer ${className ?? ''}`.trim()}>
      {/* Keyed on the file: another file starts with its own rotation and a fresh view. */}
      <FileView key={file.refId} file={file} onRotate={onRotate} lang={lang}>
        {files.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {files.map((f, i) => (
              <button key={f.refId} type="button" className="ui-btn ui-btn-sm" aria-pressed={i === index} onClick={() => setIndex(i)}>
                {t.file(i + 1)}
              </button>
            ))}
          </div>
        )}
      </FileView>
    </div>
  );
}

type Source =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; url: string; size: Size; pageCount: number };

function Icon({ d, flip }: { d: string; flip?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const ROTATE_PATH = 'M12.5 8a4.5 4.5 0 1 1-1.6-3.45M12.6 2.4v2.6H10';

function FileView({
  file,
  onRotate,
  lang,
  children,
}: {
  file: ViewerFile;
  onRotate?: (file: ViewerFile, rotation: Rotation) => Promise<boolean>;
  lang: keyof typeof TEXT;
  children?: ReactNode;
}) {
  const t = TEXT[lang];
  const isPdf = file.mimeType === 'application/pdf';
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<Source>({ kind: 'loading' });
  const [state, dispatch] = useReducer(viewerReducer, initialViewerState(file.rotation ?? 0));
  const [panel, setPanel] = useState<Size>({ width: 0, height: 0 });
  // The angle actually drawn. It only ever moves by the quarter turn just made,
  // so going from 270 to 0 turns on by 90 instead of spinning back by 270.
  const [angle, setAngle] = useState<number>(file.rotation ?? 0);
  const [animate, setAnimate] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Whether the user (or a stored value) decided the rotation; the shape-based guess applies only before that. */
  const decided = useRef(file.rotation !== null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The picture is there and its size is known. Without a stored rotation, a
   * page that is clearly wider than tall opens turned upright; that guess is
   * not stored, and it is made once, before the user has turned anything.
   */
  const ready = useCallback((url: string, pageSize: Size, pageCount: number) => {
    setSource({ kind: 'ready', url, size: pageSize, pageCount });
    if (decided.current) return;
    decided.current = true;
    const guess = initialRotation(null, pageSize);
    if (guess !== 0) {
      dispatch({ type: 'setRotation', rotation: guess });
      setAngle(guess);
    }
  }, []);

  // Load the picture: an image file as it is, a PDF page drawn to a picture.
  useEffect(() => {
    if (!isPdf) return;
    const abort = new AbortController();
    let made: string | null = null;
    renderPdfPage(file.fileUrl, page, abort.signal)
      .then((rendered) => {
        if (abort.signal.aborted) {
          URL.revokeObjectURL(rendered.url);
          return;
        }
        made = rendered.url;
        ready(rendered.url, { width: rendered.width, height: rendered.height }, rendered.pageCount);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        console.error('[receipt viewer] the PDF could not be drawn', e);
        setSource({ kind: 'failed' });
      });
    return () => {
      abort.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [isPdf, file.fileUrl, page, ready]);

  const size = source.kind === 'ready' ? source.size : null;

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => setPanel({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const act = useCallback(
    (action: ViewerAction) => {
      if (action.type === 'rotate') {
        decided.current = true;
        setAngle((a) => a + action.direction * 90);
        const next = viewerReducer(state, action).rotation;
        if (onRotate) {
          // Several quick turns are one stored value: the last one.
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            onRotate(file, next).then(
              (ok) => setSaveFailed(!ok),
              () => setSaveFailed(true),
            );
          }, 350);
        }
      }
      // A step from a button or a key eases; dragging and the wheel follow the hand directly.
      setAnimate(action.type !== 'pan' && action.type !== 'zoomBy');
      dispatch(action);
    },
    [state, onRotate, file],
  );

  // The wheel zooms only with Ctrl or Cmd (which is also what a trackpad pinch sends), so the page still scrolls past the viewer.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setAnimate(false);
      dispatch({ type: 'zoomBy', factor: Math.exp(-e.deltaY * 0.01) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const turnPage = (step: 1 | -1) => {
    setSource({ kind: 'loading' });
    dispatch({ type: 'fit' });
    setPage((p) => p + step);
  };

  const view = size ? clampPan(state, panel, size) : state;
  const scale = size ? fitScale(panel, size, view.rotation) * view.zoom : 1;
  const zoomPercent = Math.round(view.zoom * 100);
  const canPan = view.zoom > 1;

  const toolButton = (label: string, key: string, action: ViewerAction, icon: ReactNode, disabled = false) => (
    <button
      type="button"
      className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon"
      aria-label={label}
      title={`${label} (${key})`}
      disabled={disabled || source.kind !== 'ready'}
      onClick={() => act(action)}
    >
      {icon}
    </button>
  );

  return (
    <>
      <div className="ui-viewer-bar">
        <div className="flex items-center gap-0.5" role="toolbar" aria-label={t.viewer}>
          {toolButton(t.rotateLeft, 'Shift + R', { type: 'rotate', direction: -1 }, <Icon d={ROTATE_PATH} flip />)}
          {toolButton(t.rotateRight, 'R', { type: 'rotate', direction: 1 }, <Icon d={ROTATE_PATH} />)}
          <span className="ui-viewer-sep" aria-hidden="true" />
          {toolButton(t.zoomOut, '-', { type: 'zoom', direction: -1 }, <Icon d="M4 8h8" />, view.zoom <= 1)}
          <span className="w-11 text-center text-xs tabular-nums" style={{ color: 'var(--muted)' }} aria-hidden="true">
            {zoomPercent} %
          </span>
          {toolButton(t.zoomIn, '+', { type: 'zoom', direction: 1 }, <Icon d="M4 8h8M8 4v8" />)}
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost px-2 text-xs"
            title={`${t.fit} (0)`}
            disabled={source.kind !== 'ready' || (view.zoom === 1 && view.panX === 0 && view.panY === 0)}
            onClick={() => act({ type: 'fit' })}
          >
            {t.fit}
          </button>
        </div>
        <div className="flex items-center gap-1">
          {source.kind === 'ready' && source.pageCount > 1 && (
            <>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon" aria-label={t.prevPage} disabled={page <= 1} onClick={() => turnPage(-1)}>
                <Icon d="M10 3.5 5.5 8l4.5 4.5" />
              </button>
              <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                {t.page(page, source.pageCount)}
              </span>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon" aria-label={t.nextPage} disabled={page >= source.pageCount} onClick={() => turnPage(1)}>
                <Icon d="M6 3.5 10.5 8 6 12.5" />
              </button>
            </>
          )}
          <a href={file.fileUrl} target="_blank" rel="noreferrer" className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon" aria-label={t.openTab} title={t.openTab}>
            <Icon d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
          </a>
        </div>
      </div>

      <div
        ref={panelRef}
        className="ui-viewer-panel"
        tabIndex={0}
        role="group"
        aria-label={t.viewer}
        aria-describedby={`${file.refId}-keys`}
        data-dragging={dragging}
        data-pannable={canPan}
        onKeyDown={(e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || e.target !== e.currentTarget) return;
          const action = viewerKeyAction(e.key, e.shiftKey);
          if (!action) return;
          e.preventDefault();
          act(action);
        }}
        onDoubleClick={() => act(view.zoom > 1 ? { type: 'fit' } : { type: 'zoom', direction: 1 })}
        onPointerDown={(e) => {
          if (!canPan || e.button !== 0) return;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          act({ type: 'pan', dx: e.clientX - d.x, dy: e.clientY - d.y });
          drag.current = { id: d.id, x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          if (drag.current?.id !== e.pointerId) return;
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        {source.kind === 'failed' ? (
          <div className="ui-note ui-note-danger m-4 self-center" role="alert">
            {t.failed(file.originalName)}{' '}
            <a href={file.fileUrl} target="_blank" rel="noreferrer" className="underline">
              {t.openTab}
            </a>
          </div>
        ) : (
          <>
            {source.kind === 'loading' && isPdf && (
              <p className="self-center text-sm" style={{ color: 'var(--muted)' }} role="status">
                {t.loading}
              </p>
            )}
            {(source.kind === 'ready' || !isPdf) && (
              // The auth-gated file proxy cannot go through the image optimizer.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={source.kind === 'ready' ? source.url : file.fileUrl}
                alt={t.alt(file.originalName)}
                draggable={false}
                className="ui-viewer-page"
                data-animate={animate}
                style={{
                  width: size ? size.width : undefined,
                  height: size ? size.height : undefined,
                  visibility: size ? 'visible' : 'hidden',
                  transform: `translate(-50%, -50%) translate(${view.panX}px, ${view.panY}px) rotate(${angle}deg) scale(${scale})`,
                }}
                onLoad={(e) => {
                  if (isPdf) return;
                  const img = e.currentTarget;
                  ready(file.fileUrl, { width: img.naturalWidth, height: img.naturalHeight }, 1);
                }}
                onError={() => setSource({ kind: 'failed' })}
              />
            )}
          </>
        )}
      </div>

      <p id={`${file.refId}-keys`} className="sr-only">
        {t.keys}
      </p>
      <p className="sr-only" role="status">
        {source.kind === 'ready' ? t.status(view.rotation, zoomPercent) : ''}
      </p>
      {saveFailed && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {t.saveFailed}
        </p>
      )}
      {children && <div className="mt-2">{children}</div>}
    </>
  );
}
