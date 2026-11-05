// CLI-only WebKit manifest/resource validation. Does not open Safari or a WebView.
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) { fprintf(stderr, "Usage: validate-safari /absolute/extension/resources\n"); return 2; }
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
        [WKWebExtension extensionWithResourceBaseURL:url completionHandler:^(WKWebExtension *extension, NSError *error) {
            if (error || !extension) { fprintf(stderr, "%s\n", error.description.UTF8String); exit(1); }
            // Force lazy parsing of the relevant manifest sections and resources.
            BOOL injected = extension.hasInjectedContent;
            BOOL background = extension.hasBackgroundContent;
            (void)extension.requestedPermissions;
            (void)extension.allRequestedMatchPatterns;
            (void)[extension iconForSize:CGSizeMake(128, 128)];
            for (NSError *issue in extension.errors) fprintf(stderr, "%s\n", issue.description.UTF8String);
            printf("WebKit: %s %s; injected=%d background=%d errors=%lu\n",
                extension.displayName.UTF8String, extension.version.UTF8String, injected, background, (unsigned long)extension.errors.count);
            exit(extension.errors.count || !injected || !background ? 1 : 0);
        }];
        [[NSRunLoop mainRunLoop] run];
    }
    return 1;
}
