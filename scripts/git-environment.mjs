// Foreign repositories must not inherit hook selectors or command-scoped Git configuration.
export function isolatedGitEnvironment(controls = {}, inherited = process.env) {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
    ...controls
  };
}
