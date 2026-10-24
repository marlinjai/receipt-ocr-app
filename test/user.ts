import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';

/**
 * The user the component tests click and type with: no pause between actions (each pause is a timer that
 * stretches on a loaded machine) and no pointer-events check (it reads the computed style of the element and
 * every ancestor on each click). Disabled controls are still skipped, as for a person. The check is left out
 * because nothing it guards exists here: the app's styling is Tailwind classes, which have no stylesheet under
 * jsdom, and no component sets `pointer-events` inline. A component that starts doing so needs its tests to
 * use the default user.
 */
export const setupUser = () => userEvent.setup({ delay: null, pointerEventsCheck: PointerEventsCheckLevel.Never });

export type TestUser = ReturnType<typeof setupUser>;
