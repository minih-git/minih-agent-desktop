/**
 * Who may do what on this desktop (rollout R8 package D).
 *
 * A phone drives a conversation. A **desktop-class** device of the same account
 * stands where an SSH-paired owner stands (ADR amendment 3, decision 4), so it
 * also gets the session controls that restructure the computer's state and the
 * read-only file panel. The class is never inferred here: `isDesktopClassDevice`
 * in `@minih-agent/shared` is the one rule, and this module only turns it into
 * the answer a RACP operation needs.
 */
import { RacpError, type Principal } from "@minih-agent/agent-host";
import { isDesktopClassDevice, type RacpRole } from "@minih-agent/shared";

/** A principal is a same-account desktop if its stored class says so. */
export function isDesktopDevice(principal: Pick<Principal, "deviceClass" | "roles"> | undefined): boolean {
  if (!principal) return false;
  return isDesktopClassDevice({
    ...(principal.deviceClass ? { deviceClass: principal.deviceClass } : {}),
    roles: principal.roles as readonly RacpRole[],
  });
}

/**
 * Refuse an operation this device class may not perform.
 *
 * `FORBIDDEN` rather than `CAPABILITY_UNAVAILABLE`: the operation exists on this
 * Host, and this particular device is not the one allowed to call it — the same
 * distinction `session/revoke` makes for a non-owner.
 */
export function requireDesktopDevice(principal: Principal | undefined, operation: string): void {
  if (isDesktopDevice(principal)) return;
  throw new RacpError("FORBIDDEN", `${operation} is not available to this device`);
}
