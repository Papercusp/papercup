/** Values and commands shared by the SSH setup form and the real psu integration checks. */
export function buildSshConnectionCommands(input: { host: string; user: string; name: string }) {
  const address = input.host.trim();
  const username = input.user.trim();
  const profile = input.name.trim();
  const validHost = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(address);
  const validUser = username === '' || /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(username);
  const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile);
  const problem = address && !validHost ? 'Enter a hostname, IP address or SSH alias, without a username, URL or spaces.' :
    !validUser ? 'Enter only your SSH username, without spaces or an address.' :
    !validName ? 'Use 1–64 letters, digits, dots, underscores or hyphens for the connection name, starting with a letter or digit.' : null;
  const commands = validHost && validUser && validName ? {
    test: `ssh ${username ? `${username}@` : ''}${address}`,
    save: `psu --connect-add-ssh=${profile} --connect-host=${address}${username ? ` --connect-user=${username}` : ''}`,
    terminal: `psu --connect=${profile}`,
    gui: `psu --connect=${profile} --connect-gui`,
  } : null;
  return { address, profile, validName, problem, commands };
}
