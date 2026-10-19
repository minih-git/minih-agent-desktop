# Unreleased changes

- Learned memory syncs with the opt-in Memory category of Cloud sync: the notes
  you kept, in both scopes, and the deletes that keep a forgotten note from
  coming back travel between your devices, while suggestions and the counters
  below stay where they were made. Notes merge one by one, so two devices that
  each wrote something keep both instead of asking you to choose between two
  sets of notes, and a note written on both becomes one. Every device of a vault
  must run this build or newer: a build that does not know the new domain
  refuses to read a revision that carries it, so it stops syncing until it is
  updated.
- The memory manager shows how the feature is doing on this device: the size of
  the index the last session started with, how many suggestions you kept or
  discarded and at what rate, how often a delete blocked a write, and today's
  extraction spend. None of it is uploaded, and none of it syncs.
