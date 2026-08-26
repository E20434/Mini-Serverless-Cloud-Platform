// A handler that fails. Your executor must turn this into a structured
// "error" outcome — it must NOT be allowed to crash the executor process
// (an uncaught rejection/exception here would take the whole platform down
// with it, which is exactly the containment problem Phase 1 exists to solve).
exports.handler = async (event) => {
  throw new Error('Something went wrong inside the function');
};
