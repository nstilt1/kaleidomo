cd ..

zip -r kaleidomo-source.zip ./kaleidomo \
  -x "*/node_modules/*" \
  -x "*/target/*"
