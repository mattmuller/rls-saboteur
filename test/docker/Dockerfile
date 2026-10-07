# Official Postgres image plus pgTAP from the PGDG apt repository the image already uses.
# Build: docker build --build-arg PG_MAJOR=17 -t rls-saboteur-ci-pg:17 test/docker
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}
ARG PG_MAJOR
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-pgtap \
 && rm -rf /var/lib/apt/lists/*
