CC = /data/data/com.termux/files/usr/bin/clang
CFLAGS = -O2 -Wall -I/data/data/com.termux/files/usr/include
LDFLAGS = -L/data/data/com.termux/files/usr/lib -lcurl

upctl: upctl.c
	$(CC) $(CFLAGS) upctl.c $(LDFLAGS) -o upctl

clean:
	rm -f upctl

.PHONY: clean
