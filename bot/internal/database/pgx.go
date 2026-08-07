// internal/database/pgx.go
package database

import(
    "context"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
)

type pgxDB struct {
    pool *pgxpool.Pool
}

func (d *pgxDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
    return d.pool.Exec(ctx, sql, args...)
}

func (d *pgxDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
    return d.pool.Query(ctx, sql, args...)
}

func (d *pgxDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
    return d.pool.QueryRow(ctx, sql, args...)
}

func (d *pgxDB) Ping(ctx context.Context) error {
    return d.pool.Ping(ctx)
}

func (d *pgxDB) Close() {
    d.pool.Close()
}

//func New(pool *pgxpool.Pool) Database {
//    return &pgxDB{pool: pool}
//}
// internal/database/pgx.go
func New(dsn string) (Database, error) {
    ctx := context.Background()
    pool, err := pgxpool.New(ctx, dsn)
    if err != nil {
        return nil, err
    }
    return &pgxDB{pool: pool}, nil
}