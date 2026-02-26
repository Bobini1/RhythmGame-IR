Ten endpoint (GET /api/health/db) wykonuje sprawdzenie łączności z bazą danych, aby zweryfikować, czy aplikacja może pomyślnie połączyć się z bazą danych i wykonywać zapytania. Zapewnia to istotne potwierdzenie dostępności bazy danych i poprawności połączenia.

#### Wymagania dla środowiska lokalnego

**Ważne**: Ta funkcja działa obecnie tylko w środowiskach lokalnych w tym szablonie. Aby korzystać z kontroli stanu bazy danych, musisz:

- Posiadać uruchomiony lokalny serwer bazy danych (PostgreSQL, MySQL, SQLite itp.)
- Skonfigurować poprawne ustawienia połączenia z bazą danych w swoim środowisku
- Upewnić się, że dane uwierzytelniające i łańcuchy połączeń do bazy danych są prawidłowo ustawione
