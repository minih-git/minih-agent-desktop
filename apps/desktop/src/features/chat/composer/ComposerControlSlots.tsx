/**
 * The `composerControl` outlet of one toolbar side
 * (`docs/plugin-plan/ui/composer/`). Controls stack in registration order,
 * each in its own boundary; their only prop is the side they are mounted on,
 * and they reach the draft through `pi.dispatch`, never through props.
 */
import type {
  PluginComposerControlSlotProps,
  PluginSlotPosition,
} from "@minih-agent/plugin-sdk";
import {
  SlotBoundary,
  slotElement,
  useSlotEntries,
} from "../../../plugins/renderer-slots/use-slots";

export function ComposerControlSlots({
  side,
  sessionId,
}: {
  side: PluginSlotPosition;
  /** The session this composer belongs to; absent on the home composer. */
  sessionId?: string;
}) {
  const entries = useSlotEntries("composerControl", side);
  if (entries.length === 0) return null;
  const props: PluginComposerControlSlotProps = {
    position: side,
    ...(sessionId ? { sessionId } : {}),
  };
  return (
    <>
      {entries.map((entry) => (
        <SlotBoundary key={entry.id} entry={entry}>
          {slotElement(entry, props)}
        </SlotBoundary>
      ))}
    </>
  );
}
