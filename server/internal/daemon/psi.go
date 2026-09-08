package daemon

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

var readIOPSI = func() (float64, error) {
	f, err := os.Open("/proc/pressure/io")
	if err != nil { return 0, err }
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 3 || fields[0] != "full" { continue }
		for _, field := range fields[1:] {
			if strings.HasPrefix(field, "avg10=") { return strconv.ParseFloat(strings.TrimPrefix(field, "avg10="), 64) }
		}
	}
	if err := s.Err(); err != nil { return 0, err }
	return 0, os.ErrInvalid
}
