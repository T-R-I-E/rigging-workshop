# Build context is a staging dir assembled by terraform/build.sh that
# contains: toda-clj/, toda-bb/, rigging-workshop/{deps.edn,clj/}.
# This image runs either Clojure server depending on the alias passed
# as CMD by the ECS task definition (-M:server or -M:server-bb).

FROM clojure:temurin-21-tools-deps-bookworm-slim

WORKDIR /app

COPY toda-clj /app/toda-clj
COPY toda-bb  /app/toda-bb

WORKDIR /app/rigging-workshop
COPY rigging-workshop/deps.edn /app/rigging-workshop/deps.edn
COPY rigging-workshop/clj      /app/rigging-workshop/clj

# Pre-resolve maven deps for both aliases so container start doesn't
# go to the network. Local-root deps don't fetch; only mvn coords do.
# toda-core's :deps/prep-lib has already been run on the host by
# build.sh, so target/classes is present in the staged context.
RUN clojure -P -M:server && clojure -P -M:server-bb

ENTRYPOINT ["clojure"]
CMD ["-M:server"]
