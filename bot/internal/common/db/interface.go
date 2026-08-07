package db

import (
    "context"
    "database/sql"
)

type Rows interface {
    Next() bool
    Scan(dest ...interface{}) error
    Err() error
    Close() error
}

type Row interface {
    Scan(dest ...interface{}) error
}

type Database interface {
    Query(ctx context.Context, sql string, args ...interface{}) (Rows, error)
    QueryRow(ctx context.Context, sql string, args ...interface{}) Row
    Exec(ctx context.Context, sql string, args ...interface{}) (sql.Result, error)
    Close() error
}
