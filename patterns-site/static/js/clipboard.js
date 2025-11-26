// Add copy-to-clipboard functionality for code blocks
document.addEventListener('DOMContentLoaded', function() {
    // Find all code blocks
    document.querySelectorAll('pre code').forEach(function(codeBlock) {
        // Create copy button
        const button = document.createElement('button');
        button.className = 'copy-button';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy code to clipboard');

        // Style the button
        button.style.cssText = `
            position: absolute;
            top: 5px;
            right: 5px;
            padding: 4px 8px;
            font-size: 12px;
            background: #333;
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
        `;

        // Get the pre element and make it relative for button positioning
        const pre = codeBlock.parentElement;
        pre.style.position = 'relative';

        // Show button on hover
        pre.addEventListener('mouseenter', function() {
            button.style.opacity = '1';
        });
        pre.addEventListener('mouseleave', function() {
            button.style.opacity = '0';
        });

        // Copy functionality
        button.addEventListener('click', async function() {
            try {
                await navigator.clipboard.writeText(codeBlock.textContent);
                button.textContent = 'Copied!';
                button.style.background = '#28a745';

                setTimeout(function() {
                    button.textContent = 'Copy';
                    button.style.background = '#333';
                }, 2000);
            } catch (err) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = codeBlock.textContent;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.select();

                try {
                    document.execCommand('copy');
                    button.textContent = 'Copied!';
                    button.style.background = '#28a745';
                } catch (e) {
                    button.textContent = 'Failed';
                    button.style.background = '#dc3545';
                }

                document.body.removeChild(textArea);

                setTimeout(function() {
                    button.textContent = 'Copy';
                    button.style.background = '#333';
                }, 2000);
            }
        });

        pre.appendChild(button);
    });
});
