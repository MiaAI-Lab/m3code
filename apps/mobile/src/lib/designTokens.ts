export const MOBILE_SHAPE = {
  // Tech Moca: cards, grouped lists and tiles sit at 10 px; floating layers at 12 px.
  group: { ios: 10, android: 10 },
  toast: 26,
  glass: 12,
} as const;

export const MOBILE_MOTION = {
  adjust: 120,
  enter: 200,
  exit: 150,
} as const;
