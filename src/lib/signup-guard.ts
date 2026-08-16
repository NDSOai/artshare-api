const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "yopmail.com",
  "tempmail.com",
  "temp-mail.org",
  "10minutemail.com",
  "throwaway.email",
  "trashmail.com",
  "discard.email",
  "getnada.com",
  "maildrop.cc",
  "fakeinbox.com",
  "emailondeck.com",
]);

export function cleanHandle(raw: string) {
  return raw.replace(/^@/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function signupProblem(input: {
  email: string;
  name: string;
  handle: string;
}) {
  if (input.name.length < 1 || input.name.length > 80) {
    return "Name must be 1 to 80 characters.";
  }
  if (input.handle.length < 3 || input.handle.length > 24) {
    return "Handle must be 3 to 24 letters or numbers.";
  }
  if (input.email.length > 254 || !EMAIL_RE.test(input.email)) {
    return "Enter a valid email address.";
  }
  const domain = input.email.split("@")[1] ?? "";
  if (DISPOSABLE.has(domain)) {
    return "Use a regular email address.";
  }
  return null;
}
