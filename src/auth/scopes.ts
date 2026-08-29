// The fixed set of permissions an API key can be granted - the
// least-privilege half of the story from Part 4's original DTO design
// ("CI pipeline key" needing only some of a full account's abilities).
// A JWT-authenticated session (a real logged-in user, not a delegated
// key) is always granted every scope - scoping is specifically a
// mechanism for LIMITING a key you hand to something else, not a
// restriction on the account owner themselves.
export const API_SCOPES = ['functions:read', 'functions:write', 'functions:invoke'] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const ALL_SCOPES: readonly ApiScope[] = API_SCOPES;
