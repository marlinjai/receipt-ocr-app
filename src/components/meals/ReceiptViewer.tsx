'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { renderPdfPage } from '@/lib/meals/pdf-render';
import ToolIcon from '@/components/ui/ToolIcon';
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
    einvoice: 'Elektronische Rechnung (XML)',
    pageless: 'Datei ohne Seite',
    einvoiceIntro: 'Diese Rechnung ist eine reine XML-Datei ohne Seite. Ihre Angaben, wie sie in der Datei stehen:',
    einvoiceProblems: 'Diese Angaben der Rechnung passen nicht zusammen:',
    notEinvoice: (name: string) => `„${name}“ ist eine XML-Datei, aber keine lesbare elektronische Rechnung (XRechnung, ZUGFeRD oder Factur-X). Sie lässt sich nur als Datei öffnen.`,
    noPage: (name: string) => `„${name}“ hat keine Seite, die sich hier zeigen lässt. Sie lässt sich als Datei öffnen.`,
    readingFailed: (name: string) => `„${name}“ konnte nicht geladen werden.`,
    reading: 'Rechnung wird gelesen…',
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
    einvoice: 'Electronic invoice (XML)',
    pageless: 'File without a page',
    einvoiceIntro: 'This invoice is a plain XML file without a page. Its details as the invoice reader lists them (in German):',
    einvoiceProblems: 'These figures of the invoice do not add up:',
    notEinvoice: (name: string) => `"${name}" is an XML file but no readable electronic invoice (XRechnung, ZUGFeRD or Factur-X). It can only be opened as a file.`,
    noPage: (name: string) => `"${name}" has no page that can be shown here. It can be opened as a file.`,
    readingFailed: (name: string) => `"${name}" could not be loaded.`,
    reading: 'Reading the invoice…',
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
 * first, so both kinds behave the same. A file without a page (an XML
 * invoice) shows what it says instead; see PagelessView.
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
      {(() => {
        const switcher = files.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {files.map((f, i) => (
              <button key={f.refId} type="button" className="ui-btn ui-btn-sm" aria-pressed={i === index} onClick={() => setIndex(i)}>
                {t.file(i + 1)}
              </button>
            ))}
          </div>
        );
        const kind = viewerFileKind(file);
        return kind === 'pdf' || kind === 'image' ? (
          <FileView key={file.refId} file={file} onRotate={onRotate} lang={lang}>
            {switcher}
          </FileView>
        ) : (
          <PagelessView key={file.refId} file={file} kind={kind} lang={lang}>
            {switcher}
          </PagelessView>
        );
      })()}
    </div>
  );
}

/**
 * The address that shows the file turned the way it is stored for this file
 * reference (see /api/files/[fileId]). Any other address is kept as it is.
 */
export function rotatedFileUrl(file: Pick<ViewerFile, 'fileUrl' | 'refId'>): string {
  if (!/^\/api\/files\/[^/?#]+$/.test(file.fileUrl)) return file.fileUrl;
  return `${file.fileUrl}?ref=${encodeURIComponent(file.refId)}`;
}

/**
 * What the viewer can do with a file: draw a PDF page or an image, or (for
 * a file without a page) show what it says. An XRechnung arrives as a pure
 * XML file; anything else without a page is offered as a file only.
 */
export type ViewerFileKind = 'pdf' | 'image' | 'xml' | 'other';

export function viewerFileKind(file: Pick<ViewerFile, 'mimeType' | 'originalName'>): ViewerFileKind {
  const type = file.mimeType.toLowerCase().split(';')[0].trim();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml') || /\.xml$/i.test(file.originalName)) return 'xml';
  return 'other';
}

type PagelessState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'not_einvoice' }
  | { kind: 'einvoice'; text: string; problems: string[] };

/**
 * A stored file without a page. An electronic invoice is read in the
 * browser with the same reader the upload uses, and its details are shown as
 * plain text; the rotate and zoom tools have nothing to act on and are left
 * out. The file itself can always be opened as it is.
 */
function PagelessView({
  file,
  kind,
  lang,
  children,
}: {
  file: ViewerFile;
  kind: 'xml' | 'other';
  lang: keyof typeof TEXT;
  children?: ReactNode;
}) {
  const t = TEXT[lang];
  const [state, setState] = useState<PagelessState>(kind === 'xml' ? { kind: 'loading' } : { kind: 'not_einvoice' });

  useEffect(() => {
    if (kind !== 'xml') return;
    const abort = new AbortController();
    (async () => {
      const response = await fetch(file.fileUrl, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) throw new Error(`the file answered ${response.status}`);
      // A page instead of the file (a sign-in page after the session ran out) is a failed load, not "no invoice".
      if ((response.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html')) {
        throw new Error('the file answered with an HTML page');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Loaded only for an XML file: the reader brings the PDF library along.
      const { readStructuredInvoice, structuredReceiptFields } = await import('@/lib/einvoice');
      const reading = await readStructuredInvoice(bytes);
      if (abort.signal.aborted) return;
      if (!reading) {
        setState({ kind: 'not_einvoice' });
        return;
      }
      const fields = structuredReceiptFields(reading.invoice);
      setState({ kind: 'einvoice', text: fields.text, problems: fields.problems });
    })().catch((e: unknown) => {
      if (abort.signal.aborted) return;
      console.error('[receipt viewer] the XML file could not be read', e);
      setState({ kind: 'failed' });
    });
    return () => abort.abort();
  }, [kind, file.fileUrl]);

  return (
    <>
      <div className="ui-viewer-bar">
        <p className="px-2 text-sm" style={{ color: 'var(--muted)' }}>
          {kind === 'xml' ? t.einvoice : t.pageless}
        </p>
        <a href={file.fileUrl} target="_blank" rel="noreferrer" className="ui-btn ui-btn-ghost ui-viewer-tool" aria-label={t.openTab} title={t.openTab}>
          <ToolIcon name="external" />
        </a>
      </div>
      <div
        className="ui-viewer-text"
        role="region"
        aria-label={kind === 'xml' ? t.einvoice : t.pageless}
        aria-busy={state.kind === 'loading'}
        tabIndex={0}
      >
        {state.kind === 'loading' && (
          <p className="text-sm" style={{ color: 'var(--muted)' }} role="status">
            {t.reading}
          </p>
        )}
        {state.kind === 'failed' && (
          <p className="ui-note ui-note-danger" role="alert">
            {t.readingFailed(file.originalName)}
          </p>
        )}
        {state.kind === 'not_einvoice' && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {kind === 'xml' ? t.notEinvoice(file.originalName) : t.noPage(file.originalName)}
          </p>
        )}
        {state.kind === 'einvoice' && (
          <>
            <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
              {t.einvoiceIntro}
            </p>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{state.text}</pre>
            {state.problems.length > 0 && (
              <div className="ui-note ui-note-danger mt-3" role="note">
                <p>{t.einvoiceProblems}</p>
                <ul className="mt-1 list-disc pl-5">
                  {state.problems.map((problem, i) => (
                    <li key={`${i}-${problem}`}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </>
  );
}

type Source =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; url: string; size: Size; pageCount: number };

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
  /** The save waiting for the debounce; resolves whether it was stored. */
  const pendingSave = useRef<(() => Promise<boolean>) | null>(null);
  /** The save on its way to the server, until it is answered. */
  const savingNow = useRef<Promise<boolean> | null>(null);

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

  // Closing the viewer inside the debounce window must not drop the rotation: flush it.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void pendingSave.current?.();
    },
    [],
  );

  // Opened outside the app, the receipt is turned on the server by the
  // rotation stored on its file reference: the link names the reference,
  // never an angle, so it cannot show an outdated turn.
  const externalUrl = rotatedFileUrl(file);
  /**
   * A turn made just before the click may still wait for its save, or the save
   * may still be on its way. The tab is opened at once (inside the click, so
   * no popup blocker stops it) and sent to the receipt once the save is
   * through, so it shows the new rotation. When the save fails the empty tab
   * is closed again, and the viewer's note says the turn was not stored.
   */
  const openExternal = (e: MouseEvent<HTMLAnchorElement>) => {
    const pending = pendingSave.current;
    if (pending && saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const saving = pending ? pending() : savingNow.current;
    // Nothing to wait for, or a modified or middle click (background tab, new
    // window, download) the browser handles itself; the waiting save was at
    // least sent at once above, so it usually lands before that tab loads.
    if (!saving || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    void saving.then((stored) => {
      if (!stored) {
        tab?.close();
        return;
      }
      if (tab && !tab.closed) tab.location.href = externalUrl;
      else window.open(externalUrl, '_blank', 'noopener');
    });
  };

  const act = useCallback(
    (action: ViewerAction) => {
      if (action.type === 'rotate') {
        decided.current = true;
        setAngle((a) => a + action.direction * 90);
        const next = viewerReducer(state, action).rotation;
        if (onRotate) {
          // Several quick turns are one stored value: the last one.
          if (saveTimer.current) clearTimeout(saveTimer.current);
          const run = () => {
            pendingSave.current = null;
            saveTimer.current = null;
            const saving = onRotate(file, next).then(
              (ok) => {
                setSaveFailed(!ok);
                return ok;
              },
              () => {
                setSaveFailed(true);
                return false;
              },
            );
            savingNow.current = saving;
            void saving.then(() => {
              if (savingNow.current === saving) savingNow.current = null;
            });
            return saving;
          };
          pendingSave.current = run;
          saveTimer.current = setTimeout(run, 350);
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
      className="ui-btn ui-btn-ghost ui-viewer-tool"
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
        <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label={t.viewer}>
          {toolButton(t.rotateLeft, 'Shift + R', { type: 'rotate', direction: -1 }, <ToolIcon name="rotateLeft" />)}
          {toolButton(t.rotateRight, 'R', { type: 'rotate', direction: 1 }, <ToolIcon name="rotateRight" />)}
          <span className="ui-viewer-sep" aria-hidden="true" />
          {toolButton(t.zoomOut, '-', { type: 'zoom', direction: -1 }, <ToolIcon name="minus" />, view.zoom <= 1)}
          <span className="w-14 text-center text-sm tabular-nums" style={{ color: 'var(--muted)' }} aria-hidden="true">
            {zoomPercent} %
          </span>
          {toolButton(t.zoomIn, '+', { type: 'zoom', direction: 1 }, <ToolIcon name="plus" />)}
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
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
              <button type="button" className="ui-btn ui-btn-ghost ui-viewer-tool" aria-label={t.prevPage} title={t.prevPage} disabled={page <= 1} onClick={() => turnPage(-1)}>
                <ToolIcon name="chevronLeft" />
              </button>
              <span className="text-sm tabular-nums" style={{ color: 'var(--muted)' }}>
                {t.page(page, source.pageCount)}
              </span>
              <button type="button" className="ui-btn ui-btn-ghost ui-viewer-tool" aria-label={t.nextPage} title={t.nextPage} disabled={page >= source.pageCount} onClick={() => turnPage(1)}>
                <ToolIcon name="chevronRight" />
              </button>
            </>
          )}
          <a href={externalUrl} target="_blank" rel="noreferrer" onClick={openExternal} onAuxClick={openExternal} className="ui-btn ui-btn-ghost ui-viewer-tool" aria-label={t.openTab} title={t.openTab}>
            <ToolIcon name="external" />
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
            {/* The viewer could not read the file, so the stored file itself is offered, untouched. */}
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
