// Simulates a function that never returns: e.g. a DB connection or
// subscription that's opened and never cleaned up.
//
// Important, non-obvious detail: an unresolved Promise with NOTHING else
// scheduled does NOT keep a Node process alive by itself - Node only
// stays alive for active handles (a pending timer, an open socket, an
// open file descriptor). `return new Promise(() => {})` alone would let
// the process exit on its own almost immediately, which defeats the
// entire point of this fixture. The setInterval below is what genuinely
// pins the process open, the same way a real forgotten interval/open
// connection would - only an external kill (a timeout enforced from
// OUTSIDE this process) can end it.
exports.handler = async (event) => {
  setInterval(() => {}, 1000);
  return new Promise(() => {
    // deliberately never resolves, never rejects
  });
};
