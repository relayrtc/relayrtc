#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/socket.h>

/* FFmpeg is allowed to connect only to its two per-job loopback proxies.
 * This also blocks RTMP redirects from bypassing the validated upstream socket. */
int socket(int domain, int type, int protocol) {
  static int (*real_socket)(int, int, int);
  if (!real_socket) real_socket = dlsym(RTLD_NEXT, "socket");
  if (!real_socket || domain != AF_INET || (type & 0xf) != SOCK_STREAM) {
    errno = EACCES; return -1;
  }
  return real_socket(domain, type, protocol);
}
int connect(int fd, const struct sockaddr *address, socklen_t length) {
  static int (*real_connect)(int, const struct sockaddr *, socklen_t);
  if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
  if (!real_connect) { errno = EACCES; return -1; }
  const char *ports = getenv("RELAYRTC_EGRESS_LOOPBACK_PORTS");
  unsigned int first = 0, second = 0;
  if (ports && sscanf(ports, "%u,%u", &first, &second) == 2 &&
      address && address->sa_family == AF_INET && length >= sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
    unsigned int port = ntohs(ipv4->sin_port);
    if (ntohl(ipv4->sin_addr.s_addr) == INADDR_LOOPBACK && (port == first || port == second))
      return real_connect(fd, address, length);
  }
  errno = EACCES;
  return -1;
}
