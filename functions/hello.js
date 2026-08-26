// The "happy path" case: a well-behaved async handler.
exports.handler = async (event) => {
  return {
    message: `Hello, ${event.name || 'World'}!`,
  };
};
