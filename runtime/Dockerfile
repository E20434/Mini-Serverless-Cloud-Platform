# The base "Execution Runtime" image every function runs inside.
#
# Notice this image contains NO user code - the actual function file is
# bind-mounted in at container-start time by the host executor. This one
# image is reused for every invocation of every function in Phase 2. (In
# a later phase, the Build Service will instead bake user code INTO a
# per-function image - that's a deliberate, different tradeoff we'll
# discuss when we get there: generic-image-plus-mount is simpler and
# faster to iterate on locally; baked-in-per-function images are what you
# need once you're pushing/pulling across a network to remote workers.)
FROM node:20-alpine

WORKDIR /var/task

COPY shim.js /runtime/shim.js

# node:20-alpine ships a pre-existing unprivileged "node" user (uid 1000).
# Declaring it here means even a `docker run` invocation that forgets
# `--user` explicitly still never defaults to root.
USER node

ENTRYPOINT ["node", "/runtime/shim.js"]
