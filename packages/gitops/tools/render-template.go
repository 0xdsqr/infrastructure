// Offline validation only. The deployed ApplicationSet controller owns generation.
// Keep this deliberately limited to standard Go templates plus toJson, and
// cross-check changes against Argo's native preview before an ownership handoff.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"text/template"
)

type request struct {
	Template any            `json:"template"`
	Patch    string         `json:"patch"`
	Params   map[string]any `json:"params"`
}

func render(value any, params map[string]any) (any, error) {
	switch value := value.(type) {
	case string:
		t, err := template.New("application").Option("missingkey=error").Funcs(template.FuncMap{
			"toJson": func(v any) (string, error) { b, err := json.Marshal(v); return string(b), err },
		}).Parse(value)
		if err != nil {
			return nil, err
		}
		var b bytes.Buffer
		if err := t.Execute(&b, params); err != nil {
			return nil, err
		}
		return b.String(), nil
	case map[string]any:
		result := map[string]any{}
		for k, v := range value {
			r, err := render(v, params)
			if err != nil {
				return nil, err
			}
			result[k] = r
		}
		return result, nil
	case []any:
		result := make([]any, len(value))
		for i, v := range value {
			r, err := render(v, params)
			if err != nil {
				return nil, err
			}
			result[i] = r
		}
		return result, nil
	default:
		return value, nil
	}
}

func main() {
	var requests []request
	if err := json.NewDecoder(os.Stdin).Decode(&requests); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := []map[string]any{}
	for _, r := range requests {
		t, err := render(r.Template, r.Params)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		p, err := render(r.Patch, r.Params)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		results = append(results, map[string]any{"template": t, "patch": p})
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
