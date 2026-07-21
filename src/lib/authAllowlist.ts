const ALLOWED_EMAILS = [
  "shortsprojektt@gmail.com",
  "reyhanputraph@gmail.com",
  "xreyzio911@gmail.com",
] as const;

const allowedEmailSet = new Set(ALLOWED_EMAILS.map((email) => email.toLowerCase()));

export const isAllowedEmail = (email: string | null | undefined) => {
  if (!email) return false;
  return allowedEmailSet.has(email.toLowerCase());
};

export const allowedEmails = [...ALLOWED_EMAILS];
