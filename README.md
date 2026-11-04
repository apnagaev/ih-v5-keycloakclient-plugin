# Keycloak client plugin для intraHouse v5

Плагин подключает intraHouse к Keycloak:

- **импорт пользователей** из realm Keycloak с фильтрами по группам и ролям; роли или группы Keycloak становятся группами intraHouse;
- **вход через Keycloak** кнопкой «Войти через Keycloak» на форме входа (OpenID Connect, Authorization Code + PKCE), с SSO между сервисами realm.

Это форк [intrahouseio/ih-v5-keycloakclient-plugin](https://github.com/intrahouseio/ih-v5-keycloakclient-plugin). Исходный плагин сделан для IntraSCADA; здесь он доработан и проверен на intraHouse 5.19.33. Отличия от исходного — в разделе [Изменения](#изменения).

## Как это работает

```
Форма входа intraHouse ──(всплывающее окно)──► Keycloak: вход, 2FA, согласия
        ▲                                             │
        │ postMessage(code)                            ▼
 /auth/keycloak ◄──────────── redirect с code ────────┘
        │
        ▼
 сервер intraHouse ──authUser(code, code_verifier)──► плагин
                                                       │ обмен code на токены,
                                                       │ проверка подписи по JWKS,
                                                       │ логин = username по sub
        ◄──────────── login + токены ─────────────────┘
```

- Импорт и чтение групп/ролей плагин делает служебным клиентом (`client_credentials`) через Admin API.
- Вход: интерфейс intraHouse открывает страницу Keycloak во всплывающем окне, Keycloak возвращает код на `https://<intrahouse>/auth/keycloak`, эта страница передаёт код в основное окно, сервер отдаёт его плагину. Плагин меняет код на токены, проверяет подпись access token и возвращает логин. Пользователь должен быть заранее импортирован.
- Токены обновляются плагином по `refresh_token` (команда `refreshToken`), пока жива сессия Keycloak.

## Требования

- intraHouse **5.19.32** или новее (проверено на 5.19.33). В более старых версиях в интерфейсе нет кнопки Keycloak.
- Keycloak с realm, где лежат пользователи (собственные или из LDAP/AD через User federation).
- Сервер intraHouse должен достучаться до Keycloak по HTTPS (тот же адрес, что видят браузеры, либо внутренний — см. «Адрес сервера Keycloak»).

## 1. Настройка Keycloak

Ниже `<realm>` — ваш realm, `https://ih.example.com` — адрес intraHouse.

### Служебный клиент `intrascada-api` (импорт, группы, роли)

1. Clients → Create client → OpenID Connect, Client ID `intrascada-api`.
2. **Client authentication** — вкл., **Service accounts roles** — вкл.; Standard flow и Direct access grants — выкл.
3. Service accounts roles → Assign role → Filter by clients → `realm-management`:
   - `view-users` — пользователи и их роли;
   - `query-groups` — группы;
   - `view-realm` — список ролей (кнопка «Показать роли»).
4. Credentials → скопируйте **Client secret**.

### Публичный клиент `intrascada` (вход пользователей)

1. Clients → Create client → OpenID Connect, Client ID `intrascada` (имя по умолчанию в интерфейсе intraHouse).
2. **Client authentication** — выкл., **Standard flow** — вкл., остальное — выкл.
3. Valid redirect URIs: `https://ih.example.com/auth/keycloak`
4. Web origins: `https://ih.example.com`
5. Advanced → **Proof Key for Code Exchange Code Challenge Method**: `S256`.

Если у realm есть обязательные действия по умолчанию (например, Terms and Conditions), пользователь выполнит их в окне Keycloak при первом входе.

## 2. Realm `intrascada`

Интерфейс intraHouse открывает страницу входа по адресу с **зашитым realm `intrascada`**:

```
<keycloakUrl>/realms/intrascada/protocol/openid-connect/auth?client_id=...
```

Если ваш realm называется иначе, перенаправьте этот адрес на свой realm на обратном прокси перед Keycloak (nginx/OpenResty):

```nginx
location = /realms/intrascada/protocol/openid-connect/auth {
    return 302 /realms/<realm>/protocol/openid-connect/auth$is_args$args;
}
```

Затрагивается только страница входа: обмен кода и проверку токенов плагин делает в realm из своих настроек. Переименовывать сам realm не нужно, это сломает остальные сервисы.

## 3. Настройка intraHouse

### Включить кнопку Keycloak

В intraHouse нет галочки для этих параметров (в IntraSCADA она в системных настройках), но сервер их читает. Добавьте их в `/etc/intrahouse/config.json`:

```bash
cp /etc/intrahouse/config.json /root/intrahouse-config.json.bak
jq '. + {useKeycloak: 1, keycloakSSO: 1, keycloakUrl: "https://sso.example.com"}' \
  /root/intrahouse-config.json.bak > /etc/intrahouse/config.json
systemctl restart intrahouse
```

| Параметр | Значение |
|---|---|
| `useKeycloak` | `1` — показать кнопку «Войти через Keycloak» |
| `keycloakSSO` | `1` — не спрашивать пароль, если в Keycloak уже есть сессия; `0` — всегда показывать форму (`prompt=login`) |
| `keycloakUrl` | адрес Keycloak для браузера, без `/realms` и без слэша в конце |

Client ID для кнопки сервер берёт из параметра плагина «Public Client ID».

Проверка:

```bash
curl -s 'https://ih.example.com/messages?app=user' | jq '.data | {useKeycloak, keycloakSSO, keycloakUrl, keycloakClient}'
```

### Установка плагина

Плагин ставится как обычный плагин intraHouse из этого репозитория; каталог на сервере — `/var/lib/intrahouse/plugins/keycloak`. После обновления файлов перезапустите плагин.

### Параметры плагина

| Параметр | Что указать |
|---|---|
| Адрес сервера Keycloak | `https://sso.example.com` — без `/realms`, без слэша в конце. Можно внутренний адрес, если он отдаёт тот же realm |
| Realm | ваш realm |
| Client ID | `intrascada-api` |
| Client secret | секрет служебного клиента |
| Public Client ID | `intrascada` — клиент для входа и кнопки на форме |
| Поле токена с логином | обычно оставить пустым (см. «Логин при входе») |
| Группы Keycloak | фильтр импорта: имена, пути (`/smarthome`) или ID через запятую; подгруппы включаются. Пусто — все пользователи realm |
| Роли Keycloak | фильтр импорта: роли realm через запятую; импортируются пользователи, у которых есть хоть одна из них |
| Группы intraHouse создавать из | `Ролей realm`, `Групп Keycloak` или `Ролей и групп` |

При старте плагин проверяет подключение служебным клиентом и останавливается с ошибкой, если что-то не так (`HTTP 401` — секрет, `HTTP 403` — не хватает ролей `realm-management`).

## 4. Импорт пользователей

Меню плагина → **«Импорт пользователей KEYCLOAK»**. Пользователи появляются в папке KEYCLOAK:

- логин — `username` в Keycloak; имя — имя и фамилия; почта;
- в карточке — строка «Группы KEYCLOAK» (пути групп);
- **группы intraHouse** в папке KEYCLOAK — по настройке «Группы intraHouse создавать из»:
  - **Ролей realm** (по умолчанию): эффективные роли пользователя — назначенные напрямую, через группы и составные роли. `offline_access` и `uma_authorization` отбрасываются;
  - **Групп Keycloak**: группы, в которых состоит пользователь. Группа верхнего уровня называется по имени, вложенная — по пути без начального слэша (`smarthome/admins`);
  - **Ролей и групп**: оба набора; при совпадении имён остаётся одна группа.

Группы KEYCLOAK привяжите к группам доступа intraHouse (например, «Администраторы»). Без фильтров в intraHouse попадут роли и группы всех сервисов realm, поэтому задайте «Группы Keycloak» или «Роли Keycloak». Группы, которые больше не приходят при импорте, сами не удаляются.

Кнопки «Показать группы» и «Показать роли» на странице плагина выводят точные имена для фильтров.

## 5. Обратный прокси: заголовок COOP

Код из окна Keycloak передаётся в основное окно через `window.opener.postMessage`. Если на странице Keycloak или на `/auth/keycloak` стоит `Cross-Origin-Opener-Policy: same-origin` или `same-origin-allow-popups`, браузер разрывает связь окон: `window.opener` становится `null`, и окно висит на «Завершение авторизации… Пожалуйста, подождите».

Нужно `Cross-Origin-Opener-Policy: unsafe-none` (значение по умолчанию у Keycloak):

- на всех страницах входа Keycloak (`/realms/`);
- на `https://ih.example.com/auth/keycloak`.

Для основного интерфейса intraHouse `same-origin-allow-popups` можно оставить. В nginx помните, что `add_header` внутри `location` отменяет все `add_header` уровня `server`: в отдельной `location = /auth/keycloak` повторите остальные заголовки (CSP и т. д.).

## Логин при входе

Сервер intraHouse ищет импортированного пользователя по логину, который вернул плагин. Поэтому плагин берёт логин **через Admin API по `sub` токена** — это тот же `username`, что при импорте. Так вход работает, даже если `preferred_username` в токене отличается от `username` (например, маппер LDAP подставляет `sAMAccountName`, а username в realm — почта).

Если задано «Поле токена с логином» (кроме `preferred_username`), логин берётся из этого поля токена, без обращения к Admin API.

## Безопасность

- Подпись access token проверяется по JWKS realm (RS256/384/512), ключи кешируются на 5 минут.
- Секрет служебного клиента хранится как пароль плагина.
- **Журнал на подробном уровне содержит токены**: intraHouse пишет ответы плагина целиком, вместе с `access_token` и `refresh_token`. Включайте подробный уровень только на время отладки, затем верните обычный и очистите `/var/log/intrahouse/ih_keycloak.log`. Если журнал с токенами куда-то попал — завершите сессии пользователя в Keycloak (Users → пользователь → Sessions → Sign out).
- Служебному клиенту хватает ролей только на чтение (`view-users`, `query-groups`, `view-realm`).

## Неполадки

| Симптом | Причина и решение |
|---|---|
| Нет кнопки «Войти через Keycloak» | `useKeycloak` не включён: см. «Включить кнопку Keycloak»; обновите страницу с очисткой кэша |
| Keycloak: `Invalid parameter: redirect_uri` | в клиенте `intrascada` нет `https://<intrahouse>/auth/keycloak` в Valid redirect URIs |
| Keycloak: `Realm does not exist` / 404 | realm не `intrascada` и нет перенаправления — раздел 2 |
| Окно висит на «Завершение авторизации…» | в консоли окна `window.opener` = `null` — заголовок COOP, раздел 5. В журнале плагина при этом нет `authUser` |
| «No keycloak user …» | пользователь не импортирован или логин не совпал. С версии 5.0.26 логин берётся по `sub`; проверьте, что «Поле токена с логином» пустое, и повторите импорт |
| «Неверный логин/пароль» на обычной форме | обычная форма проверяет локальный пароль intraHouse; у пользователей KEYCLOAK его нет — входите кнопкой Keycloak |
| Плагин не стартует: `HTTP 401` | неверный Client secret |
| Плагин не стартует: `HTTP 403` | у service account нет ролей `realm-management` |

Для отладки поставьте плагину подробный уровень журнала: каждая команда пишется как `Keycloak command: <имя>` и список полей сообщения (без значений).

## Изменения

Относительно [исходного плагина 5.0.19](https://github.com/intrahouseio/ih-v5-keycloakclient-plugin):

- **5.0.26** — роли для групп intraHouse берутся эффективные (с учётом групп и составных ролей); настройка «Группы intraHouse создавать из» (роли, группы Keycloak или оба).
- **5.0.25** — логин при входе — `username` Keycloak по `sub`, а не `preferred_username`.
- **5.0.24** — настройка «Поле токена с логином».
- **5.0.23** — без `service: ldap`; вход через штатную кнопку Keycloak (`useKeycloak`).
- **5.0.20** — проверка пароля через Keycloak (`grant_type=password`) по команде `authUser` в формате LDAP-плагина (`dn`, `pbx`). intraHouse не вызывает её для пользователей KEYCLOAK, код оставлен на случай такой поддержки.

Ветка `ldapclient` — неудавшийся эксперимент с подменой LDAP-плагина; не используйте её.
