/**
 * Next.js calls this once when the server starts, before it serves requests.
 * It applies the shared contacts database layout when `CONTACTS_STORE=shared`;
 * with the switch off it does nothing. See src/lib/contacts/startup.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runContactsStartup } = await import('@/lib/contacts/startup');
  await runContactsStartup();
}
