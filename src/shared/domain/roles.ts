export const roles = ['volunteer', 'center-contact', 'administrator'] as const;
export type Role = typeof roles[number];
