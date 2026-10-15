/* The Engine selects this immutable entry and fixed command UID; DAC protects resident bytes. */
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>

static int command_identity(void) {
    gid_t groups[1];
    int count = getgroups(1, groups);
    return getuid() == 10003 && geteuid() == 10003 &&
        getgid() == 10002 && getegid() == 10002 &&
        count >= 0 && (count == 0 || groups[0] == 10002);
}

static void execute_helper(int argc, char **argv, int grep) {
    char *binary = grep ? "/usr/local/libexec/sept/rg" : "/usr/local/libexec/sept/fd";
    char *arguments[128];
    unsigned int count = 0;
    arguments[count++] = binary;
    /* Parent authority already checked native argv. Insert after user globs so they cannot
       restore private capture names in whole-scratch searches; pattern text may itself be --. */
    int scratch_root = strcmp(argv[argc - 1], "/tmp") == 0;
    for (int index = 2; index < argc; index++) {
        if (scratch_root && index == argc - 3) {
            arguments[count++] = grep ? "--glob" : "--exclude";
            arguments[count++] = grep ? "!sept-hands-epoch-*" : "sept-hands-epoch-*";
            arguments[count++] = grep ? "--glob" : "--exclude";
            arguments[count++] = grep ? "!sept-hands-mime-*" : "sept-hands-mime-*";
        }
        arguments[count++] = argv[index];
    }
    arguments[count] = NULL;
    execv(binary, arguments);
}

int main(int argc, char **argv) {
    if (!command_identity() || argc < 3 || argc > 122 ||
        syscall(SYS_close_range, 3U, ~0U, 0U) != 0) return 126;
    /* SIGCONT crosses UID boundaries within a session. Separate every command from the resident. */
    if (setsid() < 0 && getsid(0) != getpid()) return 126;
    if (strcmp(argv[1], "rg") == 0 || strcmp(argv[1], "fd") == 0) {
        if (argc < 5 || strcmp(argv[argc - 3], "--") != 0) return 126;
        execute_helper(argc, argv, strcmp(argv[1], "rg") == 0);
    } else if (argc == 3 && strcmp(argv[1], "bash") == 0) {
        execl("/bin/bash", "bash", "--noprofile", "--norc", "-c", argv[2], (char *)NULL);
    } else if (argc == 3 && strcmp(argv[1], "custom") == 0) {
        execl("/usr/local/bin/node", "node", "--disable-sigusr1", "--input-type=module", "--eval", argv[2], (char *)NULL);
    }
    return 126;
}
