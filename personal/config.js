// Edit these to customise your copy.
export const CONFIG = {
  title: "Boardle",
  // Puzzle #1 is shown on this date; the list then advances one puzzle per day
  // and wraps around when it runs out (1095 puzzles per mode = 3 years).
  startDate: "2026-11-03",
  modes: {
    mini:  { size: 3, label: "Mini" },
    classic: { size: 5, label: "Boardle" },
    mega:  { size: 7, label: "Mega" },
    maxi:  { size: 9, label: "Maxi" },
  },
  // Fifth tab (not a puzzle size) — hash #openings
  openings: { hash: "openings", label: "Openings" },
  defaultMode: "classic",
  // Set true to allow ?day=N in the URL to jump to any puzzle (handy for testing/practice).
  allowDayOverride: true,
};
