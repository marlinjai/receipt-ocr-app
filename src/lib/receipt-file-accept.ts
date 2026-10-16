/**
 * The file picker and the hint text of a receipt upload, derived from the one
 * list of accepted media types (ACCEPTED_RECEIPT_TYPES in
 * presigned-file-adapter.ts). A type added there (an XML invoice, say) shows
 * up in the picker and the hint without touching the places that use them.
 */

const KNOWN: Record<string, { extensions: string[]; label: string }> = {
  'application/pdf': { extensions: ['.pdf'], label: 'PDF' },
  'image/png': { extensions: ['.png'], label: 'PNG' },
  'image/jpeg': { extensions: ['.jpg', '.jpeg'], label: 'JPEG' },
  'application/xml': { extensions: ['.xml'], label: 'XML' },
  'text/xml': { extensions: ['.xml'], label: 'XML' },
};

/**
 * The `accept` attribute of a file input: every media type and its usual
 * extensions, since some systems' pickers only go by one of the two.
 */
export function acceptAttribute(types: readonly string[]): string {
  const parts = types.flatMap((type) => [type, ...(KNOWN[type]?.extensions ?? [])]);
  return [...new Set(parts)].join(',');
}

/** The accepted kinds in words for a hint ("PDF, PNG, JPEG or XML"), each kind named once. */
export function acceptedKindsLabel(types: readonly string[], or = 'or'): string {
  const labels = [...new Set(types.map((type) => KNOWN[type]?.label ?? type))];
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ${or} ${labels[labels.length - 1]}`;
}
