// internal/models/jsonb.go (если еще нет этого файла)
package models

import (
    "database/sql/driver"
    "encoding/json"
)

type JSONB map[string]interface{}

func (j JSONB) Value() (driver.Value, error) {
    if j == nil {
        return "{}", nil
    }
    return json.Marshal(j)
}

func (j *JSONB) Scan(value interface{}) error {
    if value == nil {
        *j = JSONB{}
        return nil
    }
    
    var bytes []byte
    switch v := value.(type) {
    case []byte:
        bytes = v
    case string:
        bytes = []byte(v)
    default:
        *j = JSONB{}
        return nil
    }
    
    return json.Unmarshal(bytes, j)
}
