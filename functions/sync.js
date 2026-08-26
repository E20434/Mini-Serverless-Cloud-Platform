// Edge case: a handler that is NOT async at all - just a plain
// synchronous return value, no Promise involved. Real AWS Lambda supports
// this style too (as well as an even older callback style you don't need
// to support). Decide, deliberately, whether your executor handles this -
// and if it doesn't, that should be a documented choice, not a surprise.
exports.handler = (event) => {
  return { message: 'I am not async, but I still work' };
};
