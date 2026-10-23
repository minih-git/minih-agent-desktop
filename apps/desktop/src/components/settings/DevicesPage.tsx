/**
 * 账户 ▸ Devices.
 *
 * Everything that can reach this account's machines, in one list. Pairing
 * still happens on the account page's "This computer" section; the only action
 * here is revocation, through the same signed path it has always used.
 */
import { MyDevicesSection } from "./MyDevicesSection";
import { useRemoteControl } from "./useRemoteControl";

export function DevicesPage() {
  // One control instance for the page: the renderer never writes the gateway
  // row, it only reads status and sends intents.
  const control = useRemoteControl();
  return (
    <div className="settings-stack">
      <MyDevicesSection control={control} />
    </div>
  );
}
