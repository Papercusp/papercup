export const ENGINEER_OMP_SU_WRAPPER = `#!/usr/bin/env bash
# papercusp engineer-collaborator launcher.
# Managed by Papercusp — overwriting is safe.
# Plain \`omp\` is a vanilla coding assistant; this wrapper opts into
# the engineer-collaborator playbook + the papercusp coordination
# extension.
exec omp \\
  --append-system-prompt "\${HOME}/.papercusp/engineer-collaborator.md" \\
  -e "\${HOME}/.papercusp/papercusp-coord.ts" \\
  "$@"
`;
