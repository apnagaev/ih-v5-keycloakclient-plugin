const KeycloakClient = require('./keycloak');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function app(plugin) {
  const params = plugin.params || {};
  const client = new KeycloakClient({
    url: params.url,
    realm: params.realm,
    clientId: params.clientId,
    clientSecret: plugin.getPassword(params),
    authClientId: params.authClientId,
  });
  const connection = await client.testConnection();

  if (!connection.ok) {
    plugin.exit(1, connection.message);
    return;
  }

  plugin.log(connection.message, 1);

  async function getGroups(message) {
    const groups = await client.getGroupsFlat();

    plugin.log(`Keycloak: received groups: ${groups.length}`, 1);
    plugin.sendResponse({ ...message, groups }, 1);
  }

  async function getRoles(message) {
    const roles = await client.getRealmRoles();

    plugin.log(`Keycloak: received roles: ${roles.length}`, 1);
    plugin.sendResponse({ ...message, roles }, 1);
  }

  async function syncUsers(message) {
    const result = await client.getUsersFull({
      groupFilter: params.groupFilter || '',
      roleFilter: params.roleFilter || '',
      includeSubgroups: true,
    });
    const users = mapUsers(result.users);

    plugin.send({ type: 'syncUsers', data: users });
    plugin.log(`Keycloak: sent ${users.length} users to IntraSCADA`, 1);

    if (message.uuid) plugin.sendResponse({ ...message, imported: users.length }, 1);
  }

  // Вход через обычную форму intraHouse (как у LDAP-плагина):
  // сервер присылает { param: 'authUser', dn, pbx: base64(пароль), uuid }
  // и ждет sendResponse(message, 1) при успехе или 0 при ошибке.
  async function authUserPassword(message) {
    const { uuid, dn, param } = message;
    const password = Buffer.from(String(message.pbx || ''), 'base64').toString();
    let login = '';

    try {
      login = await resolveLogin(message);
      plugin.log(`Keycloak: password auth for dn=${dn || ''} login=${login || ''}`, 1);

      const tokens = await client.passwordGrant(login, password);
      const payload = await client.verifyJwt(tokens.access_token);
      const tokenLogin = getLogin(payload);

      if (String(tokenLogin).toLowerCase() !== String(login).toLowerCase()) {
        throw new Error(`Логин в токене (${tokenLogin}) не совпадает с ${login}`);
      }

      plugin.log(`Keycloak: user authorized: ${login}`, 1);
      plugin.sendResponse(message, 1);
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      plugin.log(`Keycloak: auth failed for ${login || dn}: ${errorMessage}`);
      plugin.sendResponse({ uuid, dn, param, message: errorMessage }, 0);
    }
  }

  // dn у импортированных пользователей - это id Keycloak (UUID).
  // Логин берем из сообщения, если он есть, иначе запрашиваем по id.
  async function resolveLogin(message) {
    const direct = message.login || message.username || '';
    if (direct) return direct;

    const dn = String(message.dn || '');
    if (!UUID_RE.test(dn)) return dn;

    const user = await client.getUserById(dn);
    return (user && user.username) || dn;
  }

  async function authUser(message) {
    if (message.pbx !== undefined) {
      await authUserPassword(message);
      return;
    }

    const tokens = await client.exchangeAuthorizationCode(message);
    const payload = await client.verifyJwt(tokens.access_token);
    const login = getLogin(payload);

    if (!login) {
      throw new Error('В access_token не найден логин пользователя');
    }

    plugin.log(`Keycloak: user authorized: ${login}`, 1);
    plugin.sendResponse(
      {
        ...message,
        login,
        data: buildTokenData(tokens),
      },
      1,
    );
  }

  async function refreshToken(message) {
    const tokens = await client.refreshTokens(message);
    const payload = await client.verifyJwt(tokens.access_token);
    const login = getLogin(payload);

    if (!login) {
      throw new Error(
        'В новом access_token не найден логин пользователя',
      );
    }

    plugin.log(`Keycloak: tokens refreshed for user: ${login}`, 1);
    plugin.sendResponse(
      {
        ...message,
        login,
        data: buildTokenData(tokens),
      },
      1,
    );
  }

  const handlers = { authUser, getGroups, getRoles, refreshToken, syncUsers };

  plugin.onCommand(async (message) => {
    const command = message.param || message.command || message.type;
    const handler = handlers[command];

    plugin.log(`Keycloak command: ${command || 'undefined'}`, 1);
    plugin.log(`Keycloak command fields: ${Object.keys(message).join(', ')}`, 2);

    if (!handler) {
      plugin.log(`ERROR: Unknown command: ${command}`);
      return;
    }

    try {
      await handler(message);
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      plugin.log(`Keycloak command error: ${errorMessage}`);
      if (message.uuid || message.type === 'authUser') {
        plugin.sendResponse({ ...message, message: errorMessage }, 0);
      }
    }
  });
};

function getErrorMessage(error) {
  return error && error.message
    ? error.message
    : String(error || 'Неизвестная ошибка');
}

function getLogin(payload) {
  if (!payload) return '';
  return payload.preferred_username || payload.username || payload.email || payload.sub || '';
}

function buildTokenData(tokens) {
  const expiresIn = Number(tokens.expires_in) || 0;
  const refreshExpiresIn = Number(tokens.refresh_expires_in) || 0;

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: expiresIn,
    refresh_expires_in: refreshExpiresIn,
    token_type: tokens.token_type || 'Bearer',
    refresh_in: expiresIn ? Math.max(expiresIn - 30, 1) : 0,
  };
}

function mapUsers(users) {
  return (users || []).map((user) => ({
    dn: user.id,
    guid: user.id,
    login: user.username,
    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username,
    email: user.email || '',
    groups: (user.groups || [])
      .map((group) => group.path || group.name)
      .filter(Boolean)
      .sort(),
    roles: (user.roles || []).map(({ id, name }) => ({ id, name })),
  }));
}
