/**
 * What to tell the user after a share into the app, from the `shared` query
 * parameter the share target sets: a count (files taken into the queue), or
 * why nothing was taken.
 */
export interface SharedNotice {
  tone: 'info' | 'error';
  text: string;
}

export function sharedNotice(param: string | null | undefined): SharedNotice | null {
  if (!param) return null;
  if (/^\d+$/.test(param)) {
    const count = Number(param);
    if (count === 0) return null;
    return {
      tone: 'info',
      text: count === 1 ? '1 geteilte Datei wurde übernommen und wird jetzt verarbeitet.' : `${count} geteilte Dateien wurden übernommen und werden jetzt verarbeitet.`,
    };
  }
  if (param === 'unsupported') {
    return { tone: 'error', text: 'Die geteilte Datei ist weder ein Bild noch ein PDF und wurde nicht übernommen.' };
  }
  if (param === 'unavailable') {
    return {
      tone: 'error',
      text: 'Die geteilte Datei konnte nicht übernommen werden, weil die App im Hintergrund noch nicht bereit war. Bitte jetzt noch einmal teilen, oder das Foto hier direkt aufnehmen.',
    };
  }
  if (param === 'failed') {
    return {
      tone: 'error',
      text: 'Die geteilte Datei konnte auf diesem Gerät nicht zwischengespeichert werden. Bitte noch einmal teilen, oder das Foto hier direkt aufnehmen.',
    };
  }
  return null;
}
