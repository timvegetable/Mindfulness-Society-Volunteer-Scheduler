/** Shape check shared by verified Google sign-in emails and administrator volunteer edits. */
export const isEmailAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
