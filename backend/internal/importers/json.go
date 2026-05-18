package importers

import (
	"encoding/json"
	"io"
)

func decodeJSON(r io.Reader, dst any) error {
	return json.NewDecoder(r).Decode(dst)
}
