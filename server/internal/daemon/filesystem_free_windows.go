//go:build windows

package daemon

import "golang.org/x/sys/windows"

func filesystemFreeBytes(path string) (uint64, bool) {
	var freeBytes, totalBytes, totalFreeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(path), &freeBytes, &totalBytes, &totalFreeBytes); err != nil {
		return 0, false
	}
	return freeBytes, true
}
