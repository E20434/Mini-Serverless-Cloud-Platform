// Edge case: a module that forgot to export `handler` at all (or exported
// it under the wrong name/spelling - a very real user mistake). This is a
// PLATFORM-detected error, not a function-execution error - the distinction
// matters: your executor never even got to call anything here.
exports.notHandler = () => {
  return { message: 'you will never see this' };
};
