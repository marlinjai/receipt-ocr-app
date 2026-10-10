/**
 * Next.js calls this once when the server starts, before it serves requests.
 * It applies the layout of the shared contacts database, the app's only contact
 * store. See src/lib/contacts/startup.ts for what stops the start and what does not.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runContactsStartup } = await import('@/lib/contacts/startup');
  await runContactsStartup();
}
